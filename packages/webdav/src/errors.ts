/**
 * The kinds of failure a WebDAV client can produce. "network" covers any
 * rejected fetch call (timeouts and aborts included), since those never
 * produce an HTTP response to read a status from. "server" covers 5xx and
 * refused redirects; "unexpected" any status not listed in
 * `mapStatusToKind`.
 */
export type WebdavErrorKind =
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
 * Raised for every failure surfaced by the WebDAV client: HTTP error
 * responses, a rejected fetch, malformed or oversized multistatus bodies,
 * and local validation failures caught before a request is sent.
 */
export class WebdavError extends Error {
  readonly kind: WebdavErrorKind;
  readonly status: number | null;
  readonly detail: string | null;

  constructor(
    message: string,
    kind: WebdavErrorKind,
    status: number | null,
    detail: string | null,
  ) {
    super(message);
    this.name = "WebdavError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Maps an HTTP status to a `WebdavErrorKind`. 405 (MKCOL on an existing
 * resource), 409 (missing intermediate collection), 412 (`Overwrite: F` or
 * `If-None-Match: *` refused) and 423 (locked) are all reported as
 * `conflict`: the target is in a state that refuses the operation. 507
 * (insufficient storage) joins 413 as `payload_too_large`.
 */
export function mapStatusToKind(status: number): WebdavErrorKind {
  switch (status) {
    case 400:
    case 416:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 405:
    case 409:
    case 412:
    case 423:
      return "conflict";
    case 413:
    case 507:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    default:
      if (status >= 300 && status < 400) return "server";
      if (status >= 500 && status < 600) return "server";
      return "unexpected";
  }
}

const MAX_DETAIL_LENGTH = 500;
const MAX_ERROR_BODY_BYTES = 4096;

/**
 * Turns an error body into a short, credential-free detail: tags stripped,
 * whitespace collapsed, truncated. Servers answer errors with HTML or XML
 * pages whose markup is noise in a log line.
 */
export function extractDetail(text: string): string | null {
  const plain = text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length === 0) return null;
  return plain.length > MAX_DETAIL_LENGTH ? plain.slice(0, MAX_DETAIL_LENGTH) : plain;
}

async function readErrorBody(response: Response): Promise<string | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, MAX_ERROR_BODY_BYTES));
}

/**
 * Builds a `WebdavError` from a non-ok HTTP response, reading at most a few
 * kilobytes of its body for the detail and cancelling the rest.
 */
export async function toWebdavError(response: Response): Promise<WebdavError> {
  const status = response.status;
  const kind = mapStatusToKind(status);
  const text = await readErrorBody(response);
  const detail = text === null ? null : extractDetail(text);
  return new WebdavError(`WebDAV request failed with status ${status}`, kind, status, detail);
}

/** Converts a rejected `fetch()` (network failure, timeout, abort) into a "network" error. */
export function toNetworkError(cause: unknown): WebdavError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new WebdavError(`WebDAV request failed: ${message}`, "network", null, null);
}
