/** A half-open `[start, end)` character range to highlight within a snippet. */
export interface HighlightRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Merges overlapping or touching ranges (already sorted by `start`) into
 * the smallest equivalent set, so a snippet with two words next to each
 * other, or two words that overlap as substrings of one another, highlights
 * as one continuous span rather than several abutting or overlapping ones.
 */
function mergeRanges(sorted: readonly HighlightRange[]): HighlightRange[] {
  const merged: HighlightRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** Every `[start, end)` occurrence of `word` (case-insensitively) in `lowerText`. */
function findOccurrences(lowerText: string, word: string): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  let from = 0;
  while (from <= lowerText.length) {
    const found = lowerText.indexOf(word, from);
    if (found === -1) {
      break;
    }
    ranges.push({ start: found, end: found + word.length });
    from = found + 1;
  }
  return ranges;
}

/**
 * Finds every case-insensitive occurrence of any of `words` in `text` and
 * returns the merged, non-overlapping ranges to highlight, ordered by
 * position. Words are matched independently (so "invoice" and "voice" both
 * matching "invoices" merges into one range), and empty or whitespace-only
 * words are ignored. Used to render `<mark>` spans around the terms that
 * matched in a search snippet.
 */
export function highlightRanges(text: string, words: readonly string[]): HighlightRange[] {
  const usableWords = words
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0);
  if (usableWords.length === 0) {
    return [];
  }

  const lowerText = text.toLowerCase();
  const ranges = usableWords.flatMap((word) => findOccurrences(lowerText, word));
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  return mergeRanges(ranges);
}
