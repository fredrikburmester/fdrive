import type { EventBus } from "./bus.ts";

/** The channel the indexer notifies, with its root's name, each time the index takes in a change. */
export const INDEXED_CHANNEL = "idx_events";

/** How long `indexed` waits for more of a burst, so a scan sends browsers one signal a second. */
export const INDEXED_DELAY_MS = 1_000;

export interface IndexedSignal {
  /** The indexer took in a change; browsers hear of it within `delayMs`. */
  notify(): void;
  stop(): void;
}

/**
 * The index's "processed" signal for browsers: an `indexed` event to every
 * subscriber, naming no path, at most once per `delayMs`. What the index
 * backs (folder sizes) can differ after it, while listings come from disk
 * and change with the journal's `fs` events.
 */
export function createIndexedSignal(deps: {
  readonly bus: EventBus;
  readonly clock: () => Date;
  readonly delayMs?: number;
}): IndexedSignal {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    notify() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        deps.bus.publish({ type: "indexed", at: deps.clock().toISOString() });
      }, deps.delayMs ?? INDEXED_DELAY_MS);
      timer.unref();
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
