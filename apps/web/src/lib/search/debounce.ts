/** A debounced wrapper around a single-argument function, plus a way to cancel a pending call. */
export interface Debounced<T> {
  /** Schedules `fn(value)` after the delay, cancelling any call scheduled earlier. */
  run(value: T): void;
  /** Cancels a pending scheduled call, if any. A no-op otherwise. */
  cancel(): void;
}

/**
 * Builds a debouncer: calling `run` schedules `fn` after `delayMs`,
 * replacing any call already scheduled. Used for the search panel's 150ms
 * typing debounce. Timers are the real `setTimeout`/`clearTimeout`
 * (fake-timer friendly in tests) rather than injected, since the search
 * panel is the only caller and does not need to swap them.
 */
export function createDebouncer<T>(fn: (value: T) => void, delayMs: number): Debounced<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    run(value: T) {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        fn(value);
      }, delayMs);
    },
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
