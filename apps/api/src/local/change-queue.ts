import type { ChangeInput, ChangeWriter } from "@fdrive/db";
import type { IndexChange } from "@fdrive/local";

/** Rows per write: well under Postgres's 65,535 bind parameters at nine per row. */
export const CHANGE_BATCH = 1_000;

/**
 * Records the changes fdrive makes in the change journal, so the indexer
 * (and every later reader of `idx.changes`) hears of a new upload in
 * seconds rather than at the next scan. A row is a hint: losing one costs
 * only that wait, so nothing here ever fails a request.
 */
export interface ChangeQueue {
  /** Adds a change; it is written with the others from the same tick. */
  record(root: string, change: IndexChange): void;
  /** Writes everything recorded so far and waits for every write to finish. */
  flush(): Promise<void>;
}

export interface ChangeQueueDeps {
  readonly write: ChangeWriter;
  /** Hears a failed write; the indexer's watcher or next scan covers its changes. */
  readonly onError: (error: unknown) => void;
}

function toInput(change: IndexChange): ChangeInput {
  if (change.kind === "moved") return { path: change.path, targetPath: change.target };
  return change.content === undefined
    ? { path: change.path }
    : { path: change.path, content: change.content };
}

/**
 * Buffers changes and writes them on the next tick, one write per root and
 * at most `CHANGE_BATCH` rows each. Writes run one after another, so the
 * journal holds changes in the order they happened.
 */
export function createChangeQueue(deps: ChangeQueueDeps): ChangeQueue {
  let pending = new Map<string, ChangeInput[]>();
  let scheduled = false;
  let chain: Promise<void> = Promise.resolve();

  function report(error: unknown): void {
    try {
      deps.onError(error);
    } catch {
      // A broken error handler must not stop later writes.
    }
  }

  function drain(): void {
    scheduled = false;
    const batch = pending;
    pending = new Map();
    for (const [root, items] of batch) {
      for (let start = 0; start < items.length; start += CHANGE_BATCH) {
        const rows = items.slice(start, start + CHANGE_BATCH);
        chain = chain.then(() => deps.write(root, rows)).catch(report);
      }
    }
  }

  return {
    record(root, change) {
      const items = pending.get(root);
      if (items === undefined) pending.set(root, [toInput(change)]);
      else items.push(toInput(change));
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => {
          if (scheduled) drain();
        });
      }
    },

    flush() {
      if (scheduled) drain();
      return chain;
    },
  };
}
