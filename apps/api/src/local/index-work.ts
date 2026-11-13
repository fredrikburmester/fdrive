import type { IndexWorkInput, IndexWorkWriter } from "@fdrive/db";
import type { IndexChange } from "@fdrive/local";

/** Rows per write: well under Postgres's 65,535 bind parameters at eight per row. */
export const INDEX_WORK_BATCH = 1_000;

/**
 * Tells the indexer about changes fdrive made, so a new upload is indexed
 * in seconds rather than at the next scan. Changes are hints: losing one
 * costs only that wait, so nothing here ever fails a request.
 */
export interface IndexWorkQueue {
  /** Adds a change; it is written with the others from the same tick. */
  record(root: string, change: IndexChange): void;
  /** Writes everything recorded so far and waits for every write to finish. */
  flush(): Promise<void>;
}

export interface IndexWorkQueueDeps {
  readonly write: IndexWorkWriter;
  /** Hears a failed write; the indexer's watcher or next scan covers its changes. */
  readonly onError: (error: unknown) => void;
}

function toInput(change: IndexChange): IndexWorkInput {
  if (change.kind === "moved") return { path: change.path, targetPath: change.target };
  return change.content === undefined
    ? { path: change.path }
    : { path: change.path, content: change.content };
}

/**
 * Buffers changes and writes them on the next tick, one write per root and
 * at most `INDEX_WORK_BATCH` rows each. Writes run one after another, so the
 * indexer reads changes in the order they happened.
 */
export function createIndexWorkQueue(deps: IndexWorkQueueDeps): IndexWorkQueue {
  let pending = new Map<string, IndexWorkInput[]>();
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
      for (let start = 0; start < items.length; start += INDEX_WORK_BATCH) {
        const rows = items.slice(start, start + INDEX_WORK_BATCH);
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
