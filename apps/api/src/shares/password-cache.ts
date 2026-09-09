import { createHash, randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 256;

interface CacheEntry {
  readonly shareId: string;
  readonly verified: boolean;
  readonly expiresAt: number;
}

/** Memoized verification result for one public share thumbnail request. */
export interface SharePasswordCache {
  /** `undefined` on a miss (never verified, or the entry expired). */
  get(shareId: string, password: string): boolean | undefined;
  set(shareId: string, password: string, verified: boolean): void;
  /**
   * Forgets every verification for `shareId`. Called when the owner changes
   * or removes the share, so a rotated-away password stops answering
   * thumbnail requests immediately rather than for the rest of its TTL.
   */
  invalidate(shareId: string): void;
}

export interface SharePasswordCacheOptions {
  /** Defaults to `Date.now`. */
  readonly clock?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

/**
 * A key that is injective for `(shareId, password)` pairs without keeping
 * the password itself in memory for the entry's whole lifetime: the pair is
 * `JSON.stringify`d first (a two-element array escapes any separator
 * character either string might legitimately contain, so two distinct pairs
 * can never collide), then hashed with a salt generated fresh for this
 * process, so the retained keys are useless to anyone reading the heap and
 * cannot be attacked from a precomputed dictionary either.
 */
const KEY_SALT = randomBytes(32);

function cacheKey(shareId: string, password: string): string {
  return createHash("sha256")
    .update(KEY_SALT)
    .update(JSON.stringify([shareId, password]))
    .digest("base64");
}

/**
 * Memoizes public share thumbnail password verification: one upstream
 * share-root listing per `(share id, password)` pair is enough to answer
 * every thumbnail request in a gallery for `ttlMs`, instead of one listing
 * per tile. Bounded to `maxEntries`, evicting the oldest entry once full, so
 * an attacker probing many passwords cannot grow this map without bound.
 * Every entry is keyed by its exact password, so a rejected password's
 * cached `false` can never be read back for a different, correct password:
 * a failed verification is never cached as a success.
 */
export function createSharePasswordCache(
  options: SharePasswordCacheOptions = {},
): SharePasswordCache {
  const clock = options.clock ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, CacheEntry>();

  return {
    get(shareId, password) {
      const key = cacheKey(shareId, password);
      const entry = entries.get(key);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.expiresAt <= clock()) {
        entries.delete(key);
        return undefined;
      }
      return entry.verified;
    },
    set(shareId, password, verified) {
      const key = cacheKey(shareId, password);
      // Delete before re-inserting so a refreshed entry moves to the back
      // of the `Map`'s insertion order, giving eviction below a simple
      // oldest-first (approximately least-recently-set) policy.
      entries.delete(key);
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) {
          entries.delete(oldest);
        }
      }
      entries.set(key, { shareId, verified, expiresAt: clock() + ttlMs });
    },
    invalidate(shareId) {
      for (const [key, entry] of entries) {
        if (entry.shareId === shareId) {
          entries.delete(key);
        }
      }
    },
  };
}
