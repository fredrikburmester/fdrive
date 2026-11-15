/**
 * The result of parsing a `Range` request header against a resource of
 * `size` bytes.
 *
 * - `"none"`: no `Range` header was sent.
 * - `"single"`: one satisfiable byte range, `end` included and within the
 *   resource.
 * - `"multiple"`: a syntactically valid set of several byte ranges. fdrive
 *   serves one range at most, so callers answer with the whole resource.
 * - `"invalid"`: the header was present but unusable, either because it
 *   could not be parsed or because it falls outside the resource.
 */
export type RangeResult =
  | { kind: "none" }
  | { kind: "single"; start: number; end: number }
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
 * or the suffix form `bytes=-n`, for a resource of `size` bytes: a range
 * that starts at or past the end is invalid, and an end past it is the last
 * byte. Valid multi-range headers are identified separately so callers can
 * answer them with the whole resource.
 */
export function parseRangeHeader(header: string | null, size: number): RangeResult {
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
  // undefined here despite noUncheckedIndexedAccess. `Number(...)` on them
  // is always a non-negative integer.
  const startText = match[1] as string;
  const endText = match[2] as string;

  if (startText === "") {
    const suffixLength = Number(endText);
    if (endText === "" || suffixLength <= 0 || size <= 0) return { kind: "invalid" };
    return { kind: "single", start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startText);
  if (start >= size) return { kind: "invalid" };
  if (endText === "") return { kind: "single", start, end: size - 1 };
  const end = Number(endText);
  if (end < start) return { kind: "invalid" };
  return { kind: "single", start, end: Math.min(end, size - 1) };
}

/**
 * Whether a range request still applies under `If-Range`. fdrive sends no
 * ETag, only `Last-Modified`, so an entity tag never matches and a date
 * matches when it names the file's current second. No `If-Range` always
 * applies.
 */
export function ifRangeMatches(ifRange: string | null, modifiedAt: Date): boolean {
  if (ifRange === null) return true;
  if (ifRange.startsWith('"') || ifRange.startsWith("W/")) return false;
  const date = Date.parse(ifRange);
  return !Number.isNaN(date) && Math.floor(date / 1000) === Math.floor(modifiedAt.getTime() / 1000);
}

/**
 * What a GET of a file answers: its bytes `start` through `end`, both
 * included, whole (200) or as a range (206), or 416. An empty file is `0`
 * through `-1`.
 */
export type FileSlice =
  | { readonly status: 200 | 206; readonly start: number; readonly end: number }
  | { readonly status: 416 };

/**
 * What a GET of a file of `size` bytes, modified at `modifiedAt`, answers
 * under its `Range` and `If-Range` headers: the one byte range `range` asks
 * for, 416 when that range is unusable, and otherwise the whole file.
 * `If-Range` is checked first, so one that no longer names the file sends
 * the whole of it, as does a request for several ranges.
 */
export function fileSlice(
  file: { readonly size: number; readonly modifiedAt: Date },
  range: string | null,
  ifRange: string | null,
): FileSlice {
  const whole = { status: 200, start: 0, end: file.size - 1 } as const;
  if (!ifRangeMatches(ifRange, file.modifiedAt)) return whole;
  const parsed = parseRangeHeader(range, file.size);
  if (parsed.kind === "invalid") return { status: 416 };
  if (parsed.kind === "single") return { status: 206, start: parsed.start, end: parsed.end };
  return whole;
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
