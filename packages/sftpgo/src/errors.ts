/**
 * The kinds of failure a SftpgoClient (or the fake server standing in for
 * SFTPGo) can produce. "network" covers any rejected fetch call, including
 * timeouts and aborts, since those never produce an HTTP response to read a
 * status code from. "unexpected" covers any HTTP status that does not map
 * to one of the other kinds.
 */
export type SftpgoErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "rate_limited"
  | "bad_request"
  | "server"
  | "network"
  | "unexpected";

/**
 * Raised for every failure surfaced by the SFTPGo client: HTTP error
 * responses, a rejected fetch, and local validation failures (such as an
 * invalid virtual path) caught before a request is even sent.
 */
export class SftpgoError extends Error {
  readonly kind: SftpgoErrorKind;
  readonly status: number | null;
  readonly detail: string | null;

  constructor(
    message: string,
    kind: SftpgoErrorKind,
    status: number | null,
    detail: string | null,
  ) {
    super(message);
    this.name = "SftpgoError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Maps an HTTP status code to a SftpgoErrorKind. Any status not explicitly
 * listed (including redirects, and 4xx codes SFTPGo does not use) maps to
 * "unexpected".
 */
export function mapStatusToKind(status: number): SftpgoErrorKind {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    default:
      if (status >= 500 && status < 600) {
        return "server";
      }
      return "unexpected";
  }
}

const MAX_DETAIL_LENGTH = 500;

function truncate(text: string): string {
  return text.length > MAX_DETAIL_LENGTH ? text.slice(0, MAX_DETAIL_LENGTH) : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extracts a human-readable detail string from an error response body.
 * SFTPGo error bodies look like {"message": "...", "error": "..."}; either
 * field is used when it is a non-empty string. Any other JSON, or non-JSON
 * text, falls back to the raw body text (truncated). An empty body yields
 * null.
 */
export function extractDetail(text: string): string | null {
  if (text.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainObject(parsed)) {
      const message = parsed.message;
      if (typeof message === "string" && message.length > 0) {
        return truncate(message);
      }
      const error = parsed.error;
      if (typeof error === "string" && error.length > 0) {
        return truncate(error);
      }
    }
  } catch {
    // Not JSON; fall through to raw text below.
  }

  return truncate(text);
}

/**
 * Builds a SftpgoError from a non-ok HTTP response. Reads and discards the
 * body (SFTPGo error bodies are small JSON documents, never a stream we
 * need to preserve).
 */
export async function toSftpgoError(response: Response): Promise<SftpgoError> {
  const status = response.status;
  const kind = mapStatusToKind(status);
  let detail: string | null = null;
  try {
    const text = await response.text();
    detail = extractDetail(text);
  } catch {
    detail = null;
  }
  return new SftpgoError(`SFTPGo request failed with status ${status}`, kind, status, detail);
}

/**
 * Converts a rejected fetch() call (network failure, timeout, abort - none
 * of which produce a Response to read a status from) into a SftpgoError of
 * kind "network".
 */
export function toNetworkError(cause: unknown): SftpgoError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new SftpgoError(`SFTPGo request failed: ${message}`, "network", null, null);
}
