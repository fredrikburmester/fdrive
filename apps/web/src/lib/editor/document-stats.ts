export interface DocumentStats {
  /** 1-based line number the cursor is on. */
  readonly line: number;
  /** 1-based column within that line. */
  readonly column: number;
  /** Total length of the document, in UTF-16 code units. */
  readonly length: number;
}

/**
 * Computes the status line's line/column/length for `text` given a cursor
 * offset (a UTF-16 code unit index into `text`, as CodeMirror reports it).
 * `cursorOffset` is clamped to `[0, text.length]` so an out-of-range value
 * (there should never be one, but this keeps the function total) never
 * throws.
 */
export function computeDocumentStats(text: string, cursorOffset: number): DocumentStats {
  const clamped = Math.min(Math.max(cursorOffset, 0), text.length);
  const before = text.slice(0, clamped);
  const line = before.split("\n").length;
  // -1 when there is no newline before the cursor, in which case the
  // column is simply `before.length + 1` (1-based); the same subtraction
  // below produces that without a separate branch.
  const lastNewline = before.lastIndexOf("\n");
  const column = before.length - lastNewline;

  return { line, column, length: text.length };
}
