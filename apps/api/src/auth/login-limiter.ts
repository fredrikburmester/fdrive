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
  /**
   * Maximum number of distinct keys tracked at once. Bounds the memory an
   * attacker can consume by forging a new ip or username on every request.
   * Defaults to `DEFAULT_CAPACITY`. Once the map is full, a key with no
   * existing state is denied (fails closed) rather than being tracked.
   */
  readonly capacity?: number;
}

/** The fixed login rate-limit policy fdrive uses everywhere it does not override it. */
export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_BLOCK_MS = 60_000;
/** Default cap on the number of distinct rate-limit keys tracked at once. */
export const DEFAULT_CAPACITY = 10_000;

interface KeyState {
  /** Failure timestamps (ms since epoch) within the current window. */
  failures: number[];
  /** When set and in the future, the key is blocked until this time (ms since epoch). */
  blockedUntil: number | null;
}

/** True once a state carries no information worth keeping: no recent failures, no active block. */
function isIdle(state: KeyState): boolean {
  return state.failures.length === 0 && state.blockedUntil === null;
}

/**
 * Creates a `LoginLimiter`. Every call prunes failures older than `windowMs`
 * and clears expired blocks across every tracked key, then drops any key
 * left with no failures and no active block, mirroring the sweep in
 * `shares/limiter.ts`. That bounds the map's steady-state size without a
 * background timer.
 */
export function createLoginLimiter(opts: CreateLoginLimiterOptions): LoginLimiter {
  const maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const blockMs = opts.blockMs ?? DEFAULT_BLOCK_MS;
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const states = new Map<string, KeyState>();

  function sweep(nowMs: number): void {
    for (const [key, state] of states) {
      state.failures = state.failures.filter((at) => nowMs - at < windowMs);
      if (state.blockedUntil !== null && state.blockedUntil <= nowMs) {
        state.blockedUntil = null;
      }
      if (isIdle(state)) {
        states.delete(key);
      }
    }
  }

  /**
   * Sweeps expired state, then returns the (possibly freshly created) state
   * for `key`, or `undefined` when `key` is new and the map is already at
   * `capacity` (fail closed: the caller must treat this as not allowed).
   */
  function pruneAndGet(key: string, nowMs: number): KeyState | undefined {
    sweep(nowMs);
    const existing = states.get(key);
    if (existing !== undefined) {
      return existing;
    }
    if (states.size >= capacity) {
      return undefined;
    }
    const created: KeyState = { failures: [], blockedUntil: null };
    states.set(key, created);
    return created;
  }

  return {
    check(key) {
      const nowMs = opts.clock().getTime();
      const state = pruneAndGet(key, nowMs);
      if (state === undefined) {
        return { allowed: false };
      }
      if (state.blockedUntil !== null) {
        return { allowed: false, retryAfterMs: state.blockedUntil - nowMs };
      }
      return { allowed: true };
    },

    recordFailure(key) {
      const nowMs = opts.clock().getTime();
      const state = pruneAndGet(key, nowMs);
      if (state === undefined) {
        return;
      }
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
