/**
 * A pure, in-memory login rate limiter keyed by an opaque string (the
 * caller combines ip and username into `${ip}|${username}`). After
 * `maxFailures` failures within `windowMs`, the key is blocked for
 * `blockMs`. A success clears all failure history for the key.
 */
export interface LoginLimiter {
  check(key: string): { allowed: boolean; retryAfterMs?: number };
  recordFailure(key: string): void;
  recordSuccess(key: string): void;
}

export interface CreateLoginLimiterOptions {
  readonly clock: () => Date;
  /** Failures before a key is blocked. Defaults to `DEFAULT_MAX_FAILURES`. */
  readonly maxFailures?: number;
  /** The rolling window failures are counted within. Defaults to `DEFAULT_WINDOW_MS`. */
  readonly windowMs?: number;
  /** How long a key stays blocked once `maxFailures` is reached. Defaults to `DEFAULT_BLOCK_MS`. */
  readonly blockMs?: number;
}

/** The fixed login rate-limit policy fdrive uses everywhere it does not override it. */
export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_BLOCK_MS = 60_000;

interface KeyState {
  /** Failure timestamps (ms since epoch) within the current window. */
  failures: number[];
  /** When set and in the future, the key is blocked until this time (ms since epoch). */
  blockedUntil: number | null;
}

/**
 * Creates a `LoginLimiter`. Failures older than `windowMs` are dropped
 * lazily on the next `check` or `recordFailure` for that key, so the
 * limiter never needs a background sweep.
 */
export function createLoginLimiter(opts: CreateLoginLimiterOptions): LoginLimiter {
  const maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const blockMs = opts.blockMs ?? DEFAULT_BLOCK_MS;
  const states = new Map<string, KeyState>();

  function pruneAndGet(key: string, nowMs: number): KeyState {
    const state = states.get(key) ?? { failures: [], blockedUntil: null };
    state.failures = state.failures.filter((at) => nowMs - at < windowMs);
    if (state.blockedUntil !== null && state.blockedUntil <= nowMs) {
      state.blockedUntil = null;
    }
    states.set(key, state);
    return state;
  }

  return {
    check(key) {
      const nowMs = opts.clock().getTime();
      const state = pruneAndGet(key, nowMs);
      if (state.blockedUntil !== null) {
        return { allowed: false, retryAfterMs: state.blockedUntil - nowMs };
      }
      return { allowed: true };
    },

    recordFailure(key) {
      const nowMs = opts.clock().getTime();
      const state = pruneAndGet(key, nowMs);
      state.failures.push(nowMs);
      if (state.failures.length >= maxFailures) {
        state.blockedUntil = nowMs + blockMs;
        state.failures = [];
      }
    },

    recordSuccess(key) {
      states.delete(key);
    },
  };
}
