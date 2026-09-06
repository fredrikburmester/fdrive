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
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly blockMs: number;
}

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
  const states = new Map<string, KeyState>();

  function pruneAndGet(key: string, nowMs: number): KeyState {
    const state = states.get(key) ?? { failures: [], blockedUntil: null };
    state.failures = state.failures.filter((at) => nowMs - at < opts.windowMs);
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
      if (state.failures.length >= opts.maxFailures) {
        state.blockedUntil = nowMs + opts.blockMs;
        state.failures = [];
      }
    },

    recordSuccess(key) {
      states.delete(key);
    },
  };
}
