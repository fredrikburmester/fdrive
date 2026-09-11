/**
 * The result of parsing a `Range` request header against a resource of a
 * (possibly unknown) size.
 *
 * - `"none"`: no `Range` header was sent.
 * - `"single"`: a single satisfiable byte range, `end` present only when
 *   the header (or a known size) pinned one down.
 * - `"multiple"`: a syntactically valid set of multiple byte ranges. The
 *   storage contract only supports a single range, so callers ignore this
 *   header and return the complete representation.
 * - `"invalid"`: the header was present but unusable, either because it
 *   could not be parsed or (when `size` is known) fell outside the resource.
 */
export type RangeResult =
  | { kind: "none" }
  | { kind: "single"; start: number; end?: number }
  | { kind: "multiple" }
  | { kind: "invalid" };

const SINGLE_RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;
const BYTE_RANGE_SPEC_PATTERN = /^(\d*)-(\d*)$/;

function compareDecimalIntegers(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/, "") || "0";
  const normalizedRight = right.replace(/^0+/, "") || "0";
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length - normalizedRight.length;
  }
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function isValidByteRangeSpec(value: string): boolean {
  const match = BYTE_RANGE_SPEC_PATTERN.exec(value.trim());
  if (!match) return false;
  const start = match[1] as string;
  const end = match[2] as string;
  if (start === "" && end === "") return false;
  return start === "" || end === "" || compareDecimalIntegers(start, end) <= 0;
}

function isValidMultipleByteRange(header: string): boolean {
  if (!header.startsWith("bytes=")) return false;
  const ranges = header.slice(6).split(",");
  return ranges.length > 1 && ranges.every(isValidByteRangeSpec);
}

/**
 * Parses an HTTP `Range` request header of the form `bytes=a-b`, `bytes=a-`,
 * or the suffix form `bytes=-n`. Valid multi-range headers are identified
 * separately so single-range-only callers can ignore them and return the
 * complete representation.
 *
 * `size`, when known, is used to reject a range that starts at or beyond
 * the end of the resource and to clamp (or resolve, for the suffix form) an
 * open-ended range. A suffix range without a known `size` is invalid: there
 * is nothing to count the suffix back from.
 */
export function parseRangeHeader(header: string | null, size: number | null): RangeResult {
  if (header === null) {
    return { kind: "none" };
  }

  if (header.includes(",")) {
    return isValidMultipleByteRange(header) ? { kind: "multiple" } : { kind: "invalid" };
  }

  const match = SINGLE_RANGE_PATTERN.exec(header);
  if (!match) {
    return { kind: "invalid" };
  }

  // The pattern's two capture groups are both `\d*`, which always matches
  // (possibly the empty string), so `match[1]` and `match[2]` are never
  // undefined here despite noUncheckedIndexedAccess.
  const startText = match[1] as string;
  const endText = match[2] as string;

  if (startText === "" && endText === "") {
    return { kind: "invalid" };
  }

  if (startText === "") {
    return parseSuffixRange(endText, size);
  }

  return parseBoundedRange(startText, endText, size);
}

// `suffixText` and the start/end text below always come from the
// `\d*`-only capture groups in `SINGLE_RANGE_PATTERN`, so `Number(...)` on
// them is always a non-negative integer (or, for `suffixText` and
// `endText`, never called on an empty string here); there is no
// not-a-number or negative case to guard against.

function parseSuffixRange(suffixText: string, size: number | null): RangeResult {
  const suffixLength = Number(suffixText);
  if (suffixLength <= 0) {
    return { kind: "invalid" };
  }
  if (size === null || size <= 0) {
    return { kind: "invalid" };
  }
  return { kind: "single", start: Math.max(0, size - suffixLength), end: size - 1 };
}

function parseBoundedRange(startText: string, endText: string, size: number | null): RangeResult {
  const start = Number(startText);
  if (size !== null && start >= size) {
    return { kind: "invalid" };
  }

  if (endText === "") {
    return { kind: "single", start };
  }

  const end = Number(endText);
  if (end < start) {
    return { kind: "invalid" };
  }

  return { kind: "single", start, end: size !== null ? Math.min(end, size - 1) : end };
}

const ASCII_FALLBACK_PATTERN = /[^\x20-\x7e]|["\\]/g;

/**
 * Builds an ASCII-safe fallback for a `Content-Disposition` filename:
 * anything outside printable ASCII, plus `"` and `\` (which would break
 * the quoted-string), becomes `_`. Falls back to `"download"` when that
 * leaves nothing usable.
 */
function asciiFallbackFilename(filename: string): string {
  const sanitized = filename.replace(ASCII_FALLBACK_PATTERN, "_");
  return sanitized.length > 0 ? sanitized : "download";
}

/** Characters `encodeURIComponent` leaves unescaped but RFC 5987 does not allow raw. */
const EXTRA_RFC5987_ESCAPES = /['()*]/g;

function encodeRfc5987(filename: string): string {
  return encodeURIComponent(filename).replace(
    EXTRA_RFC5987_ESCAPES,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Builds a `Content-Disposition` header value for `kind` ("inline" or
 * "attachment") and `filename`, with both a quoted ASCII-safe fallback
 * filename and an RFC 5987 `filename*=UTF-8''...` extended value so
 * clients that understand it get the exact (possibly non-ASCII) name.
 */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const fallback = asciiFallbackFilename(filename);
  const extended = encodeRfc5987(filename);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${extended}`;
}
