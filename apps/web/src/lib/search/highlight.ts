/** A `[start, end)` range into a snippet's text to render as highlighted. */
export interface HighlightRange {
  readonly start: number;
  readonly end: number;
}

/** One piece of a snippet, either plain text or a highlighted match. */
export interface SnippetSegment {
  readonly text: string;
  readonly highlighted: boolean;
}

/**
 * Splits `text` into a sequence of plain/highlighted segments from `ranges`,
 * so a component can render each with or without a `<mark>` in one pass
 * rather than computing substring math in JSX. Ranges are sorted and
 * clamped to `text`'s bounds; overlapping ranges merge into one highlighted
 * segment. An empty `ranges` array returns the whole text as one
 * non-highlighted segment.
 */
export function splitSnippetSegments(
  text: string,
  ranges: readonly HighlightRange[],
): SnippetSegment[] {
  if (ranges.length === 0) {
    return text.length === 0 ? [] : [{ text, highlighted: false }];
  }

  const sorted = [...ranges]
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, text.length)),
      end: Math.max(0, Math.min(range.end, text.length)),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);

  const segments: SnippetSegment[] = [];
  let cursor = 0;

  for (const range of sorted) {
    const start = Math.max(range.start, cursor);
    if (start >= range.end) {
      continue;
    }
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), highlighted: false });
    }
    segments.push({ text: text.slice(start, range.end), highlighted: true });
    cursor = range.end;
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlighted: false });
  }

  return segments;
}
