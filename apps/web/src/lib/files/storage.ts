/**
 * The subset of the Web Storage API used by this module's persisted
 * preferences. Callers pass in `window.localStorage` (or a fake in tests)
 * so this file never touches a global directly.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Reads and JSON-parses `key` from `storage`, returning `fallback` when the
 * key is absent, the stored value fails to parse, or `isValid` rejects the
 * parsed value. Storage access itself is wrapped in try/catch because some
 * browsers throw when storage is disabled (private browsing, blocked
 * cookies) rather than returning null.
 */
export function readJson<T>(
  storage: StorageLike,
  key: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
): T {
  try {
    const raw = storage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Serializes `value` as JSON into `storage` under `key`. Failures (quota
 * exceeded, storage disabled) are swallowed: persisting a preference is
 * best-effort and must never break the caller.
 */
export function writeJson<T>(storage: StorageLike, key: string, value: T): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort: ignore quota errors and disabled storage
  }
}
