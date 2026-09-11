/**
 * A pure, in-memory login rate limiter keyed by an opaque string (the
 * caller combines ip and username into `${ip}|${username}`). After
 * `maxFailures` failures within `windowMs`, the key is blocked for
 * `blockMs`. A success clears all failure history for the key.
 */
export interface LoginLimiter {
  /**
   * `group` names the caller a key belongs to (fdrive passes the client
   * address block). One group may hold at most `maxKeysPerGroup` of the
   * map's slots, so a caller inventing a key per attempt cannot crowd
   * every other caller out of it; see `createLoginLimiter`.
   */
  check(key: string, group?: string): { allowed: boolean; retryAfterMs?: number };
  recordFailure(key: string, group?: string): void;
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
  /**
   * Maximum number of those keys one `group` may hold at once. Defaults to
   * `DEFAULT_MAX_KEYS_PER_GROUP`. Over that budget a new key is not
   * tracked at all (see `check`), which is deliberately not the same as
   * the fail-closed denial `capacity` produces.
   */
  readonly maxKeysPerGroup?: number;
}

/** The fixed login rate-limit policy fdrive uses everywhere it does not override it. */
export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_BLOCK_MS = 60_000;
/** Default cap on the number of distinct rate-limit keys tracked at once. */
export const DEFAULT_CAPACITY = 10_000;
/**
 * Default cap on the slots a single group holds. A key only survives the
 * sweep once it has a recorded failure, and a caller that pairs grouped
 * keys with an ungrouped per-group bucket (as `accounts/credentials.ts`
 * does) is cut off after `maxFailures` failures per window, so no honest
 * caller reaches eight live keys. Capping it keeps one address block to 8
 * of the 10 000 default slots: filling the map takes over a thousand
 * distinct blocks instead of one caller cycling usernames.
 */
export const DEFAULT_MAX_KEYS_PER_GROUP = 8;

interface KeyState {
  /** Failure timestamps (ms since epoch) within the current window. */
  failures: number[];
  /** When set and in the future, the key is blocked until this time (ms since epoch). */
  blockedUntil: number | null;
  /** The group this key was first seen with, whose budget its slot counts against. */
  group: string | undefined;
}

/** Why a key has no state of its own: the map is full, or its group is at its budget. */
type Untracked = "capacity" | "fan-out";

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
 *
 * `capacity` bounds the map overall and fails closed when it is reached, so
 * it is a denial of service in itself if one caller can fill it: hence
 * `maxKeysPerGroup`, which bounds the slots a single group holds. Keys over
 * that budget are left untracked rather than evicting live or blocked ones,
 * because evicting under pressure would let an attacker flush the very
 * failure counts and blocks that throttle them.
 */
export function createLoginLimiter(opts: CreateLoginLimiterOptions): LoginLimiter {
  const maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const blockMs = opts.blockMs ?? DEFAULT_BLOCK_MS;
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const maxKeysPerGroup = opts.maxKeysPerGroup ?? DEFAULT_MAX_KEYS_PER_GROUP;
  const states = new Map<string, KeyState>();
  /** How many tracked keys each group currently holds; no entry means none. */
  const groupSizes = new Map<string, number>();

  function release(key: string, state: KeyState): void {
    states.delete(key);
    if (state.group === undefined) {
      return;
    }
    const remaining = (groupSizes.get(state.group) ?? 1) - 1;
    if (remaining <= 0) {
      groupSizes.delete(state.group);
    } else {
      groupSizes.set(state.group, remaining);
    }
  }

  function sweep(nowMs: number): void {
    for (const [key, state] of states) {
      state.failures = state.failures.filter((at) => nowMs - at < windowMs);
      if (state.blockedUntil !== null && state.blockedUntil <= nowMs) {
        state.blockedUntil = null;
      }
      if (isIdle(state)) {
        release(key, state);
      }
    }
  }

  /**
   * Sweeps expired state, then returns the (possibly freshly created) state
   * for `key`. A key with no state yet gets none when its group is at
   * `maxKeysPerGroup` (`"fan-out"`) or the map is at `capacity`
   * (`"capacity"`); the group budget is checked first so a caller that has
   * already spent its own slots cannot deny the rest of the map on its way
   * past them. A key keeps the group it was created with.
   */
  function pruneAndGet(
    key: string,
    group: string | undefined,
    nowMs: number,
  ): KeyState | Untracked {
    sweep(nowMs);
    const existing = states.get(key);
    if (existing !== undefined) {
      return existing;
    }
    if (group !== undefined && (groupSizes.get(group) ?? 0) >= maxKeysPerGroup) {
      return "fan-out";
    }
    if (states.size >= capacity) {
      return "capacity";
    }
    const created: KeyState = { failures: [], blockedUntil: null, group };
    states.set(key, created);
    if (group !== undefined) {
      groupSizes.set(group, (groupSizes.get(group) ?? 0) + 1);
    }
    return created;
  }

  return {
    check(key, group) {
      const nowMs = opts.clock().getTime();
      const state = pruneAndGet(key, group, nowMs);
      if (state === "capacity") {
        return { allowed: false };
      }
      // An untracked key has no history to judge it by, and denying it
      // would turn one group's fan-out into a lockout for every key it
      // invents. The caller's own ungrouped per-group bucket keeps those
      // attempts bounded instead.
      if (state === "fan-out") {
        return { allowed: true };
      }
      if (state.blockedUntil !== null) {
        return { allowed: false, retryAfterMs: state.blockedUntil - nowMs };
      }
      return { allowed: true };
    },

    recordFailure(key, group) {
      const nowMs = opts.clock().getTime();
      const state = pruneAndGet(key, group, nowMs);
      if (state === "capacity" || state === "fan-out") {
        return;
      }
      state.failures.push(nowMs);
      if (state.failures.length >= maxFailures) {
        state.blockedUntil = nowMs + blockMs;
        state.failures = [];
      }
    },

    recordSuccess(key) {
      const state = states.get(key);
      if (state !== undefined) {
        release(key, state);
      }
    },
  };
}
