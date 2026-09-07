/** Default TTL for a resolved verification result, per `docs/workflow/P5-SCOPE-ENGINE.md`. */
export const DEFAULT_SCOPE_CACHE_TTL_MS = 30_000;

/** Default cap on cached entries, per `docs/workflow/P5-SCOPE-ENGINE.md` ("at most 1000 identities"). */
export const DEFAULT_SCOPE_CACHE_MAX_ENTRIES = 1000;

export interface CreateScopeCacheDeps {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly clock?: () => Date;
}

/**
 * A small TTL cache with in-flight coalescing, keyed by an exact string
 * (the caller builds the key from every input that must invalidate the
 * result, e.g. identity, provider, template, roots, and overrides).
 */
export interface ScopeCache<T> {
  /**
   * Returns the cached value for `key` when it is still fresh; otherwise
   * calls `compute` once (concurrent callers for the same `key` share that
   * one call) and caches the result. A rejection from `compute` is never
   * cached: eviction can only remove a would-be grant, never manufacture
   * one from a stale success.
   */
  get(key: string, compute: () => Promise<T>): Promise<T>;
  /** Removes every cached and in-flight entry whose key starts with `prefix`. */
  invalidatePrefix(prefix: string): void;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAtMs: number;
}

/** Builds a `ScopeCache`. See `ScopeCache` for the coalescing and eviction contract. */
export function createScopeCache<T>(deps: CreateScopeCacheDeps = {}): ScopeCache<T> {
  const ttlMs = deps.ttlMs ?? DEFAULT_SCOPE_CACHE_TTL_MS;
  const maxEntries = deps.maxEntries ?? DEFAULT_SCOPE_CACHE_MAX_ENTRIES;
  const clock = deps.clock ?? (() => new Date());

  const entries = new Map<string, CacheEntry<T>>();
  const inflight = new Map<string, Promise<T>>();

  function evictOldestUntilWithinCap(): void {
    // `entries.size > maxEntries` (checked by the loop condition) implies
    // `entries.size > 0`, so the map's first key always exists here; the
    // `Map` iterator's type just cannot express that.
    while (entries.size > maxEntries) {
      const [oldestKey] = entries.keys();
      entries.delete(oldestKey as string);
    }
  }

  return {
    async get(key, compute) {
      const nowMs = clock().getTime();
      const cached = entries.get(key);
      if (cached !== undefined && cached.expiresAtMs > nowMs) {
        return cached.value;
      }

      const existingInflight = inflight.get(key);
      if (existingInflight !== undefined) {
        return existingInflight;
      }

      const promise = compute();
      inflight.set(key, promise);
      try {
        const value = await promise;
        // Re-insert so Map's iteration order (used for FIFO eviction below)
        // reflects recency rather than the original insertion time.
        entries.delete(key);
        entries.set(key, { value, expiresAtMs: clock().getTime() + ttlMs });
        evictOldestUntilWithinCap();
        return value;
      } finally {
        inflight.delete(key);
      }
    },

    invalidatePrefix(prefix) {
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
        }
      }
      for (const key of inflight.keys()) {
        if (key.startsWith(prefix)) {
          inflight.delete(key);
        }
      }
    },
  };
}
