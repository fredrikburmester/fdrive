import { toNetworkError, toSftpgoError } from "./errors.js";

/** Removes a single trailing slash from a base URL, if present. */
export function stripTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Builds a request URL from a base URL, a fixed path, and a set of query
 * parameters. Undefined values are omitted; every other value is coerced to
 * a string and URL-encoded by URLSearchParams.
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): string {
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
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
 * When timeoutMs is null, no timeout is applied (used for streaming
 * requests, which only honour a caller-provided signal).
 */
export function combineSignals(
  userSignal: AbortSignal | undefined,
  timeoutMs: number | null,
): AbortSignal {
  const signals: AbortSignal[] = [];
  if (userSignal) {
    signals.push(userSignal);
  }
  if (timeoutMs !== null) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  if (signals.length === 0) {
    return new AbortController().signal;
  }
  return AbortSignal.any(signals);
}

/**
 * Performs a fetch call, converting a rejected promise into a SftpgoError of
 * kind "network" rather than letting the underlying error escape.
 */
export async function safeFetch(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (cause) {
    throw toNetworkError(cause);
  }
}

/**
 * Performs a fetch call and throws a SftpgoError unless the response status
 * is in okStatuses (defaults to any 2xx status).
 */
export async function fetchChecked(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  okStatuses?: readonly number[],
): Promise<Response> {
  const response = await safeFetch(fetchImpl, url, init);
  const ok = okStatuses ? okStatuses.includes(response.status) : response.ok;
  if (!ok) {
    throw await toSftpgoError(response);
  }
  return response;
}

export function parseIntOrNull(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parseDateOrNull(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
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
