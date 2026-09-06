/** How long, in ms, consecutive keystrokes are treated as one type-ahead query. */
export const TYPE_AHEAD_TIMEOUT_MS = 800;

export interface TypeAheadBuffer {
  readonly query: string;
  readonly lastTypedAt: number;
}

export const EMPTY_TYPE_AHEAD_BUFFER: TypeAheadBuffer = { query: "", lastTypedAt: 0 };

/**
 * Appends `char` to `previous.query` when it arrived within
 * `TYPE_AHEAD_TIMEOUT_MS` of the last keystroke, otherwise starts a fresh
 * query with just `char`. `now` is injected so this stays pure and testable.
 */
export function nextTypeAheadBuffer(
  previous: TypeAheadBuffer,
  char: string,
  now: number,
  timeoutMs: number = TYPE_AHEAD_TIMEOUT_MS,
): TypeAheadBuffer {
  const continuesQuery = now - previous.lastTypedAt <= timeoutMs;
  const query = continuesQuery ? previous.query + char : char;
  return { query, lastTypedAt: now };
}

/**
 * Finds the index of the first name in `names` (searching from `startIndex`
 * and wrapping around) whose lowercase form starts with `query`. Returns
 * `null` when `query` is empty, `names` is empty, or nothing matches.
 */
export function typeAheadMatch(
  names: readonly string[],
  query: string,
  startIndex = 0,
): number | null {
  if (query.length === 0 || names.length === 0) {
    return null;
  }

  const lowerQuery = query.toLowerCase();
  const count = names.length;
  const normalizedStart = ((startIndex % count) + count) % count;

  for (let offset = 0; offset < count; offset++) {
    const index = (normalizedStart + offset) % count;
    const name = names[index];
    if (name?.toLowerCase().startsWith(lowerQuery)) {
      return index;
    }
  }

  return null;
}
