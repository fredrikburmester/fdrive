import { toWebdavError, WebdavError } from "./errors.js";
import {
  basicAuthHeader,
  buildUrl,
  cancelBody,
  combineSignals,
  drainBounded,
  emptyByteStream,
  fetchChecked,
  parseDateOrNull,
  parseIntOrNull,
  readTextBounded,
  safeFetch,
} from "./http.js";
import { assertValidPath, baseNameOf, parentOf, resolveHref } from "./path.js";
import type {
  ByteRange,
  CopyMoveOptions,
  DownloadOptions,
  DownloadResult,
  UploadOptions,
  WebdavClient,
  WebdavClientOptions,
  WebdavCredential,
  WebdavEntry,
  WebdavStat,
  WebdavUserApi,
} from "./types.js";
import { type MultistatusResponse, PROPFIND_BODY, parseMultistatus } from "./xml.js";

const DEFAULT_USER_AGENT = "fdrive";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MULTISTATUS_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_MULTISTATUS_ENTRIES = 100_000;
/** How much of a Depth 1 listing a read probe consumes before cancelling. */
const PROBE_DRAIN_BYTES = 64 * 1024;

interface ClientContext {
  readonly baseUrl: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxMultistatusBytes: number;
  readonly maxMultistatusEntries: number;
}

interface ResolvedResponse extends MultistatusResponse {
  readonly path: string;
}

function formatRange(range: ByteRange): string {
  return `bytes=${range.start}-${range.end ?? ""}`;
}

function authHeaders(ctx: ClientContext, credential: WebdavCredential): Headers {
  const headers = new Headers();
  headers.set("User-Agent", ctx.userAgent);
  headers.set("Authorization", basicAuthHeader(credential.username, credential.password));
  return headers;
}

function statOf(response: MultistatusResponse): WebdavStat {
  const { props } = response;
  return {
    kind: props.collection ? "dir" : "file",
    size: props.collection ? 0 : (props.contentLength ?? 0),
    modifiedAt: props.lastModified,
    contentType: props.collection ? null : props.contentType,
    etag: props.etag,
  };
}

/**
 * Sends a `PROPFIND` and returns its responses with hrefs resolved to
 * provider paths. Responses naming another origin or a path outside the
 * endpoint are dropped, never followed. The body is bounded in bytes before
 * parsing and in entries after.
 */
async function propfind(
  ctx: ClientContext,
  credential: WebdavCredential,
  path: string,
  depth: "0" | "1",
  collection: boolean,
): Promise<ResolvedResponse[]> {
  const headers = authHeaders(ctx, credential);
  headers.set("Depth", depth);
  headers.set("Content-Type", "application/xml; charset=utf-8");
  const response = await fetchChecked(
    ctx.fetchImpl,
    buildUrl(ctx.baseUrl, path, { collection }),
    {
      method: "PROPFIND",
      headers,
      body: PROPFIND_BODY,
      signal: combineSignals(undefined, ctx.timeoutMs),
    },
    [207],
  );
  const text = await readTextBounded(response, ctx.maxMultistatusBytes);
  if (text === null) {
    throw new WebdavError(
      "WebDAV multistatus body could not be read",
      "unexpected",
      207,
      `body exceeds ${ctx.maxMultistatusBytes} bytes or was cut short`,
    );
  }
  const resolved: ResolvedResponse[] = [];
  for (const entry of parseMultistatus(text, ctx.maxMultistatusEntries)) {
    const resolvedPath = resolveHref(entry.href, ctx.baseUrl);
    if (resolvedPath !== null) resolved.push({ ...entry, path: resolvedPath });
  }
  return resolved;
}

/**
 * The response describing `path` itself in a `PROPFIND` answer. A
 * response-level 404 (some servers answer 207 for a missing member) is a
 * `not_found`; an answer without any usable response is `unexpected`.
 */
function selfOf(responses: readonly ResolvedResponse[], path: string): ResolvedResponse {
  const self = responses.find((entry) => entry.path === path);
  if (self === undefined) {
    throw new WebdavError(
      "WebDAV PROPFIND answer does not describe the requested path",
      "unexpected",
      207,
      "no response matched the request href",
    );
  }
  if (self.status === 404) {
    throw new WebdavError("WebDAV resource not found", "not_found", 404, null);
  }
  return self;
}

async function performDownload(
  ctx: ClientContext,
  credential: WebdavCredential,
  path: string,
  options: DownloadOptions | undefined,
): Promise<DownloadResult> {
  const headers = authHeaders(ctx, credential);
  if (options?.range) headers.set("Range", formatRange(options.range));
  if (options?.ifRange) headers.set("If-Range", options.ifRange);
  const response = await safeFetch(ctx.fetchImpl, buildUrl(ctx.baseUrl, path), {
    method: "GET",
    headers,
    signal: combineSignals(options?.signal, null),
  });
  const status = response.status;
  if (status !== 200 && status !== 206) throw await toWebdavError(response);
  return {
    status,
    body: response.body ?? emptyByteStream(),
    contentLength: parseIntOrNull(response.headers.get("content-length")),
    contentRange: response.headers.get("content-range"),
    contentType: response.headers.get("content-type"),
    lastModified: parseDateOrNull(response.headers.get("last-modified")),
  };
}

async function performUpload(
  ctx: ClientContext,
  credential: WebdavCredential,
  path: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
  options: UploadOptions | undefined,
): Promise<void> {
  const headers = authHeaders(ctx, credential);
  headers.set("Content-Type", "application/octet-stream");
  if (options?.contentLength !== undefined) {
    headers.set("Content-Length", String(options.contentLength));
  }
  if (options?.modifiedAt) {
    headers.set("X-OC-Mtime", String(Math.floor(options.modifiedAt.getTime() / 1000)));
  }
  if (options?.overwrite === false) headers.set("If-None-Match", "*");
  const init: RequestInit & { duplex?: "half" } = {
    method: "PUT",
    headers,
    body,
    signal: combineSignals(options?.signal, null),
  };
  // Node's fetch requires an explicit duplex mode for streamed bodies.
  if (body instanceof ReadableStream) init.duplex = "half";
  const response = await fetchChecked(ctx.fetchImpl, buildUrl(ctx.baseUrl, path), init);
  await cancelBody(response);
}

async function performCopyMove(
  ctx: ClientContext,
  credential: WebdavCredential,
  method: "COPY" | "MOVE",
  path: string,
  target: string,
  options: CopyMoveOptions | undefined,
): Promise<void> {
  assertValidPath(path);
  assertValidPath(target);
  const headers = authHeaders(ctx, credential);
  headers.set("Destination", buildUrl(ctx.baseUrl, target));
  headers.set("Overwrite", options?.overwrite === false ? "F" : "T");
  if (method === "COPY") headers.set("Depth", "infinity");
  const response = await fetchChecked(ctx.fetchImpl, buildUrl(ctx.baseUrl, path), {
    method,
    headers,
    signal: combineSignals(undefined, ctx.timeoutMs),
  });
  await cancelBody(response);
}

async function statPath(
  ctx: ClientContext,
  credential: WebdavCredential,
  path: string,
): Promise<WebdavStat> {
  const responses = await propfind(ctx, credential, path, "0", false);
  return statOf(selfOf(responses, path));
}

function createUserApi(ctx: ClientContext, credential: WebdavCredential): WebdavUserApi {
  const timeoutSignal = () => combineSignals(undefined, ctx.timeoutMs);

  return {
    async list(path: string): Promise<WebdavEntry[]> {
      assertValidPath(path);
      const responses = await propfind(ctx, credential, path, "1", true);
      const self = selfOf(responses, path);
      if (!self.props.collection) {
        throw new WebdavError("WebDAV resource is not a collection", "bad_request", 207, null);
      }
      const entries: WebdavEntry[] = [];
      for (const entry of responses) {
        if (entry.path === path || parentOf(entry.path) !== path) continue;
        if (entry.status !== null && (entry.status < 200 || entry.status >= 300)) continue;
        const stat = statOf(entry);
        entries.push({ name: baseNameOf(entry.path), path: entry.path, ...stat });
      }
      return entries;
    },

    stat(path: string): Promise<WebdavStat> {
      assertValidPath(path);
      return statPath(ctx, credential, path);
    },

    async probeDirectoryRead(path: string): Promise<void> {
      assertValidPath(path);
      const stat = await statPath(ctx, credential, path);
      if (stat.kind !== "dir") {
        throw new WebdavError("WebDAV resource is not a collection", "bad_request", 207, null);
      }
      const headers = authHeaders(ctx, credential);
      headers.set("Depth", "1");
      headers.set("Content-Type", "application/xml; charset=utf-8");
      const response = await fetchChecked(
        ctx.fetchImpl,
        buildUrl(ctx.baseUrl, path, { collection: true }),
        { method: "PROPFIND", headers, body: PROPFIND_BODY, signal: timeoutSignal() },
        [207],
      );
      await drainBounded(response, PROBE_DRAIN_BYTES);
    },

    download(path: string, options?: DownloadOptions): Promise<DownloadResult> {
      assertValidPath(path);
      return performDownload(ctx, credential, path, options);
    },

    upload(
      path: string,
      body: ReadableStream<Uint8Array> | Uint8Array,
      options?: UploadOptions,
    ): Promise<void> {
      assertValidPath(path);
      return performUpload(ctx, credential, path, body, options);
    },

    async mkcol(path: string): Promise<void> {
      assertValidPath(path);
      const response = await fetchChecked(
        ctx.fetchImpl,
        buildUrl(ctx.baseUrl, path, { collection: true }),
        { method: "MKCOL", headers: authHeaders(ctx, credential), signal: timeoutSignal() },
      );
      await cancelBody(response);
    },

    move: (path, target, options) =>
      performCopyMove(ctx, credential, "MOVE", path, target, options),
    copy: (path, target, options) =>
      performCopyMove(ctx, credential, "COPY", path, target, options),

    async delete(path: string): Promise<void> {
      assertValidPath(path);
      const response = await fetchChecked(ctx.fetchImpl, buildUrl(ctx.baseUrl, path), {
        method: "DELETE",
        headers: authHeaders(ctx, credential),
        signal: timeoutSignal(),
      });
      await cancelBody(response);
    },
  };
}

/** Builds a client for one WebDAV endpoint; `user(credential)` binds it to one login. */
export function createWebdavClient(options: WebdavClientOptions): WebdavClient {
  const ctx: ClientContext = {
    baseUrl: options.baseUrl,
    fetchImpl: options.fetch ?? globalThis.fetch,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxMultistatusBytes: options.maxMultistatusBytes ?? DEFAULT_MAX_MULTISTATUS_BYTES,
    maxMultistatusEntries: options.maxMultistatusEntries ?? DEFAULT_MAX_MULTISTATUS_ENTRIES,
  };
  return {
    baseUrl: ctx.baseUrl,
    user: (credential) => createUserApi(ctx, credential),
  };
}
