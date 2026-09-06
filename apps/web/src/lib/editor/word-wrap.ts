/**
 * The subset of the Web Storage API this module needs. Callers pass in
 * `window.localStorage` (or a fake in tests) so this file never touches a
 * global directly.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const WORD_WRAP_STORAGE_KEY = "fdrive.editor.wordWrap";

export const DEFAULT_WORD_WRAP = false;

/**
 * Reads the persisted word-wrap preference from `storage`, falling back to
 * `DEFAULT_WORD_WRAP` when it is absent or not one of the two known
 * literal values. Storage access is wrapped in try/catch because some
 * browsers throw when storage is disabled rather than returning null.
 */
export function readWordWrap(storage: StorageLike): boolean {
  try {
    const raw = storage.getItem(WORD_WRAP_STORAGE_KEY);
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
    return DEFAULT_WORD_WRAP;
  } catch {
    return DEFAULT_WORD_WRAP;
  }
}

/**
 * Persists `wrap` to `storage`. Failures (quota exceeded, storage
 * disabled) are swallowed: persisting a preference is best-effort and must
 * never break the caller.
 */
export function writeWordWrap(storage: StorageLike, wrap: boolean): void {
  try {
    storage.setItem(WORD_WRAP_STORAGE_KEY, wrap ? "true" : "false");
  } catch {
    // best-effort: ignore quota errors and disabled storage
  }
}
