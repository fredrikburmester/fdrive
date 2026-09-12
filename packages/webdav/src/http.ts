import { toNetworkError, toWebdavError, WebdavError } from "./errors.js";
import { assertValidPath, encodePath, endpointPrefix } from "./path.js";

/**
 * Builds the request URL for a provider path under the endpoint. The path
 * is always joined *under* the endpoint's own path, so a server confined to
 * a prefix by a reverse proxy (`https://files.example/dav`) keeps that
 * prefix, and a path can never escape the configured origin. Collections
 * get a trailing slash, which several servers require to answer a
 * `PROPFIND` on a directory without redirecting. Throws `bad_request` for
 * a path the URL parser would resolve outside the prefix.
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  options: { collection?: boolean } = {},
): string {
  assertValidPath(path);
  const base = new URL(baseUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  base.search = "";
  base.hash = "";
  const url = new URL(encodePath(path), base);
  if (options.collection === true && !url.pathname.endsWith("/")) url.pathname += "/";
  if (url.origin !== base.origin || !url.pathname.startsWith(endpointPrefix(baseUrl))) {
    throw new WebdavError(
      `WebDAV path escapes the endpoint: ${JSON.stringify(path)}`,
      "bad_request",
      null,
      null,
    );
  }
  return url.toString();
}

/** Builds a Basic auth header value for the given username and password. */
export function basicAuthHeader(username: string, password: string): string {
  const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/**
 * Combines an optional caller-provided AbortSignal with a timeout signal.
 * When timeoutMs is null, no timeout is applied (streaming requests only
 * honour a caller-provided signal).
 */
export function combineSignals(
  userSignal: AbortSignal | undefined,
  timeoutMs: number | null,
): AbortSignal {
  const signals: AbortSignal[] = [];
  if (userSignal) signals.push(userSignal);
  if (timeoutMs !== null) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return new AbortController().signal;
  return AbortSignal.any(signals);
}

/** Cancels an unread response body so the connection can be released. */
export async function cancelBody(response: Response): Promise<void> {
  if (response.body === null || response.bodyUsed) return;
  await response.body.cancel().catch(() => undefined);
}

/**
 * Builds the error for a 3xx response. Every request is sent with
 * `redirect: "manual"`: following a redirect automatically would send the
 * Basic credential to whatever origin the `Location` names, which is a
 * credential leak if that answer is attacker-influenced (a misconfigured
 * or compromised proxy in front of the server). Operators configure the
 * final endpoint URL instead.
 */
export async function toRedirectError(response: Response): Promise<WebdavError> {
  await cancelBody(response);
  const location = response.headers.get("location");
  return new WebdavError(
    `WebDAV request redirected with status ${response.status}`,
    "server",
    response.status,
    location === null ? "redirect refused" : "redirect refused; configure the final endpoint URL",
  );
}

/**
 * Performs a fetch call, converting a rejected promise into a "network"
 * `WebdavError` and any 3xx answer into a "server" one (see
 * `toRedirectError`). Always requests `redirect: "manual"`.
 */
export async function safeFetch(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "manual" });
  } catch (cause) {
    throw toNetworkError(cause);
  }
  if (response.status >= 300 && response.status < 400) {
    throw await toRedirectError(response);
  }
  return response;
}

/** Performs a fetch call and throws unless the status is one of `okStatuses` (default: any 2xx). */
export async function fetchChecked(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  okStatuses?: readonly number[],
): Promise<Response> {
  const response = await safeFetch(fetchImpl, url, init);
  const ok = okStatuses ? okStatuses.includes(response.status) : response.ok;
  if (!ok) throw await toWebdavError(response);
  return response;
}

/**
 * Reads a response body as text, refusing more than `maxBytes` (from
 * `Content-Length` when declared, otherwise as the stream arrives). Returns
 * `null` when the bound is exceeded or the body cannot be read; the
 * remainder is cancelled either way.
 */
export async function readTextBounded(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await cancelBody(response);
    return null;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Reads and discards up to `maxBytes` of a body, then cancels it: proves the
 * server actually streams an answer without buffering a whole listing.
 */
export async function drainBounded(response: Response, maxBytes: number): Promise<void> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function parseIntOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parseDateOrNull(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A ReadableStream that immediately closes without emitting any data. */
export function emptyByteStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}
