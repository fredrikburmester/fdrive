import { probeDirectoryStream } from "./directory-probe.js";
import { type RawSftpgoEntry, toEntry } from "./entries.js";
import { SftpgoError, toSftpgoError } from "./errors.js";
import {
  basicAuthHeader,
  buildUrl,
  combineSignals,
  emptyByteStream,
  fetchChecked,
  parseDateOrNull,
  parseIntOrNull,
  safeFetch,
  stripTrailingSlash,
} from "./http.js";
import { assertValidPath } from "./path.js";
import { type RawSftpgoShare, shareInputToWire, toShare } from "./shares.js";
import type {
  ByteRange,
  DownloadOptions,
  DownloadResult,
  SftpgoClient,
  SftpgoClientOptions,
  SftpgoEntry,
  SftpgoFileStat,
  SftpgoProfile,
  SftpgoPublicShareApi,
  SftpgoShareInput,
  SftpgoToken,
  SftpgoUserApi,
  UploadOptions,
} from "./types.js";

const DEFAULT_USER_AGENT = "fdrive";
const DEFAULT_TIMEOUT_MS = 30000;
const SHARES_LIST_LIMIT = 500;

interface ClientContext {
  readonly baseUrl: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly userAgent: string;
  readonly timeoutMs: number;
}

function formatRange(range: ByteRange): string {
  return `bytes=${range.start}-${range.end ?? ""}`;
}

function authHeaders(ctx: ClientContext, authorization: string | null): Headers {
  const headers = new Headers();
  headers.set("User-Agent", ctx.userAgent);
  if (authorization !== null) {
    headers.set("Authorization", authorization);
  }
  return headers;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function performDownload(
  ctx: ClientContext,
  url: string,
  authorization: string | null,
  options: DownloadOptions | undefined,
): Promise<DownloadResult> {
  const headers = authHeaders(ctx, authorization);
  if (options?.rangeHeader !== undefined) {
    if (!/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(options.rangeHeader))
      throw new SftpgoError("Invalid range", "bad_request", null, null);
    headers.set("Range", options.rangeHeader);
  }
  if (options?.range) {
    headers.set("Range", formatRange(options.range));
  }
  if (options?.ifRange) {
    headers.set("If-Range", options.ifRange);
  }

  const response = await safeFetch(ctx.fetchImpl, url, {
    method: "GET",
    headers,
    signal: combineSignals(options?.signal, null),
  });

  const status = response.status;
  if (status !== 200 && status !== 206) {
    throw await toSftpgoError(response);
  }

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
  url: string,
  authorization: string | null,
  body: ReadableStream<Uint8Array> | Uint8Array,
  options: UploadOptions | undefined,
  signal: AbortSignal,
): Promise<void> {
  const headers = authHeaders(ctx, authorization);
  if (options?.modifiedAt) {
    headers.set("X-SFTPGO-MTIME", String(options.modifiedAt.getTime()));
  }
  if (options?.contentLength !== undefined) {
    headers.set("Content-Length", String(options.contentLength));
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers,
    body,
    signal,
  };
  if (body instanceof ReadableStream) {
    // Node's fetch requires an explicit duplex mode for streamed bodies.
    init.duplex = "half";
  }

  await fetchChecked(ctx.fetchImpl, url, init);
}

function createUserApi(ctx: ClientContext, token: string): SftpgoUserApi {
  const authorization = `Bearer ${token}`;

  const timeoutSignal = () => combineSignals(undefined, ctx.timeoutMs);

  return {
    async list(path: string): Promise<SftpgoEntry[]> {
      assertValidPath(path);
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/dirs", { path });
      const response = await fetchChecked(ctx.fetchImpl, url, {
        method: "GET",
        headers: authHeaders(ctx, authorization),
        signal: timeoutSignal(),
      });
      const raw = await readJson<RawSftpgoEntry[]>(response);
      return raw.map(toEntry);
    },

    async probeDirectoryRead(path: string): Promise<void> {
      assertValidPath(path);
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/dirs", { path });
      const response = await fetchChecked(ctx.fetchImpl, url, {
        method: "GET",
        headers: authHeaders(ctx, authorization),
        signal: timeoutSignal(),
      });
      if (!response.body) {
        throw new SftpgoError("Missing response body for directory probe", "server", null, null);
      }
      await probeDirectoryStream(response.body);
    },

    async statFile(path: string): Promise<SftpgoFileStat> {
      assertValidPath(path);
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/files", { path });
      const response = await fetchChecked(ctx.fetchImpl, url, {
        method: "HEAD",
        headers: authHeaders(ctx, authorization),
        signal: timeoutSignal(),
      });
      return {
        size: parseIntOrNull(response.headers.get("content-length")) ?? 0,
        modifiedAt: parseDateOrNull(response.headers.get("last-modified")),
        contentType: response.headers.get("content-type"),
      };
    },

    async download(path: string, options?: DownloadOptions): Promise<DownloadResult> {
      assertValidPath(path);
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/files", { path });
      return performDownload(ctx, url, authorization, options);
    },

    async upload(
      path: string,
      body: ReadableStream<Uint8Array> | Uint8Array,
      options?: UploadOptions,
    ): Promise<void> {
      assertValidPath(path);
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/files/upload", {
        path,
        mkdir_parents: options?.mkdirParents ? "true" : "false",
      });
      await performUpload(
        ctx,
        url,
        authorization,
        body,
        options,
        combineSignals(options?.signal, null),
      );
    },

    async mkdir(path: string, options?: { parents?: boolean }): Promise<void> {
      assertValidPath(path);
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/dirs", {
        path,
        mkdir_parents: options?.parents ? "true" : "false",
      });
      await fetchChecked(ctx.fetchImpl, url, {
        method: "POST",
        headers: authHeaders(ctx, authorization),
        signal: timeoutSignal(),
      });
    },

    async move(path: string, target: string): Promise<void> {
      assertValidPath(path);
      assertValidPath(target);
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/file-actions/move", { path, target });
      await fetchChecked(ctx.fetchImpl, url, {
        method: "POST",
        headers: authHeaders(ctx, authorization),
        signal: timeoutSignal(),
      });
    },

    async copy(path: string, target: string): Promise<void> {
      assertValidPath(path);
      assertValidPath(target);
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/file-actions/copy", { path, target });
      await fetchChecked(ctx.fetchImpl, url, {
        method: "POST",
        headers: authHeaders(ctx, authorization),
        signal: timeoutSignal(),
      });
    },

    async deleteFile(path: string): Promise<void> {
      assertValidPath(path);
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/files", { path });
      await fetchChecked(ctx.fetchImpl, url, {
        method: "DELETE",
        headers: authHeaders(ctx, authorization),
        signal: timeoutSignal(),
      });
    },

    async deleteDir(path: string): Promise<void> {
      assertValidPath(path);
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/dirs", { path });
      await fetchChecked(ctx.fetchImpl, url, {
        method: "DELETE",
        headers: authHeaders(ctx, authorization),
        signal: timeoutSignal(),
      });
    },

    async setModifiedAt(path: string, modifiedAt: Date): Promise<void> {
      assertValidPath(path);
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/files/metadata", { path });
      const headers = authHeaders(ctx, authorization);
      headers.set("Content-Type", "application/json");
      await fetchChecked(ctx.fetchImpl, url, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ modification_time: modifiedAt.getTime() }),
        signal: timeoutSignal(),
      });
    },

    async zip(
      paths: readonly string[],
      options?: { signal?: AbortSignal },
    ): Promise<ReadableStream<Uint8Array>> {
      for (const path of paths) {
        assertValidPath(path);
      }
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/streamzip");
      const headers = authHeaders(ctx, authorization);
      headers.set("Content-Type", "application/json");
      const response = await fetchChecked(ctx.fetchImpl, url, {
        method: "POST",
        headers,
        body: JSON.stringify(paths),
        signal: combineSignals(options?.signal, null),
      });
      return response.body ?? emptyByteStream();
    },

    async profile(): Promise<SftpgoProfile> {
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/profile");
      const response = await fetchChecked(ctx.fetchImpl, url, {
        method: "GET",
        headers: authHeaders(ctx, authorization),
        signal: timeoutSignal(),
      });
      const raw = await readJson<{
        email?: string;
        description?: string;
        allow_api_key_auth?: boolean;
        public_keys?: string[];
      }>(response);
      return {
        email: raw.email ?? "",
        description: raw.description ?? "",
        allowApiKeyAuth: raw.allow_api_key_auth ?? false,
        publicKeys: raw.public_keys ?? [],
      };
    },

    shares: {
      async list() {
        const url = buildUrl(ctx.baseUrl, "/api/v2/user/shares", { limit: SHARES_LIST_LIMIT });
        const response = await fetchChecked(ctx.fetchImpl, url, {
          method: "GET",
          headers: authHeaders(ctx, authorization),
          signal: timeoutSignal(),
        });
        const raw = await readJson<RawSftpgoShare[]>(response);
        return raw.map(toShare);
      },

      async get(id: string) {
        const url = buildUrl(ctx.baseUrl, `/api/v2/user/shares/${encodeURIComponent(id)}`);
        const response = await fetchChecked(ctx.fetchImpl, url, {
          method: "GET",
          headers: authHeaders(ctx, authorization),
          signal: timeoutSignal(),
        });
        return toShare(await readJson<RawSftpgoShare>(response));
      },

      async create(input: SftpgoShareInput) {
        const url = buildUrl(ctx.baseUrl, "/api/v2/user/shares");
        const headers = authHeaders(ctx, authorization);
        headers.set("Content-Type", "application/json");
        const response = await fetchChecked(
          ctx.fetchImpl,
          url,
          {
            method: "POST",
            headers,
            body: JSON.stringify(shareInputToWire(input, false)),
            signal: timeoutSignal(),
          },
          [201],
        );
        const id = response.headers.get("x-object-id") ?? "";
        return { id };
      },

      async update(id: string, input: SftpgoShareInput) {
        const url = buildUrl(ctx.baseUrl, `/api/v2/user/shares/${encodeURIComponent(id)}`);
        const headers = authHeaders(ctx, authorization);
        headers.set("Content-Type", "application/json");
        await fetchChecked(ctx.fetchImpl, url, {
          method: "PUT",
          headers,
          body: JSON.stringify(shareInputToWire(input, true)),
          signal: timeoutSignal(),
        });
      },

      async remove(id: string) {
        const url = buildUrl(ctx.baseUrl, `/api/v2/user/shares/${encodeURIComponent(id)}`);
        await fetchChecked(ctx.fetchImpl, url, {
          method: "DELETE",
          headers: authHeaders(ctx, authorization),
          signal: timeoutSignal(),
        });
      },
    },
  };
}

function createPublicShareApi(
  ctx: ClientContext,
  shareId: string,
  password: string | undefined,
): SftpgoPublicShareApi {
  const authorization = password !== undefined ? basicAuthHeader("share", password) : null;
  const basePath = `/api/v2/shares/${encodeURIComponent(shareId)}`;

  return {
    async list(path = "/"): Promise<SftpgoEntry[]> {
      assertValidPath(path);
      const url = buildUrl(ctx.baseUrl, `${basePath}/dirs`, { path });
      const response = await fetchChecked(ctx.fetchImpl, url, {
        method: "GET",
        headers: authHeaders(ctx, authorization),
        signal: combineSignals(undefined, ctx.timeoutMs),
      });
      const raw = await readJson<RawSftpgoEntry[]>(response);
      return raw.map(toEntry);
    },

    async download(path: string, options?: DownloadOptions): Promise<DownloadResult> {
      assertValidPath(path);
      return performDownload(
        ctx,
        buildUrl(ctx.baseUrl, `${basePath}/files`, { path }),
        authorization,
        options,
      );
    },
    async downloadFile(options?: DownloadOptions): Promise<DownloadResult> {
      return performDownload(
        ctx,
        buildUrl(ctx.baseUrl, basePath, { compress: "false" }),
        authorization,
        options,
      );
    },

    async zip(options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
      const url = buildUrl(ctx.baseUrl, basePath, { compress: "true" });
      const response = await fetchChecked(ctx.fetchImpl, url, {
        method: "GET",
        headers: authHeaders(ctx, authorization),
        signal: combineSignals(options?.signal, null),
      });
      return response.body ?? emptyByteStream();
    },

    async upload(
      fileName: string,
      body: ReadableStream<Uint8Array> | Uint8Array,
      options?: { modifiedAt?: Date; contentLength?: number; signal?: AbortSignal },
    ): Promise<void> {
      // SFTPGo unescapes the route parameter after Go has decoded the URL path.
      const url = buildUrl(
        ctx.baseUrl,
        `${basePath}/${encodeURIComponent(encodeURIComponent(fileName))}`,
      );
      await performUpload(
        ctx,
        url,
        authorization,
        body,
        options,
        combineSignals(options?.signal, null),
      );
    },
  };
}

/** Creates a client for talking to a SFTPGo server's user-facing REST API. */
export function createSftpgoClient(options: SftpgoClientOptions): SftpgoClient {
  const ctx: ClientContext = {
    baseUrl: stripTrailingSlash(options.baseUrl),
    fetchImpl: options.fetch ?? globalThis.fetch,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  return {
    async login(input: { username: string; password: string; otp?: string }): Promise<SftpgoToken> {
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/token");
      const headers = authHeaders(ctx, basicAuthHeader(input.username, input.password));
      if (input.otp !== undefined) {
        headers.set("X-SFTPGO-OTP", input.otp);
      }
      const response = await fetchChecked(ctx.fetchImpl, url, {
        method: "GET",
        headers,
        signal: combineSignals(undefined, ctx.timeoutMs),
      });
      const raw = await readJson<{ access_token: string; expires_at: string }>(response);
      return { accessToken: raw.access_token, expiresAt: new Date(raw.expires_at) };
    },

    async logout(token: string): Promise<void> {
      const url = buildUrl(ctx.baseUrl, "/api/v2/user/logout");
      await fetchChecked(ctx.fetchImpl, url, {
        method: "GET",
        headers: authHeaders(ctx, `Bearer ${token}`),
        signal: combineSignals(undefined, ctx.timeoutMs),
      });
    },

    user(token: string): SftpgoUserApi {
      return createUserApi(ctx, token);
    },

    publicShare(shareId: string, password?: string): SftpgoPublicShareApi {
      return createPublicShareApi(ctx, shareId, password);
    },
  };
}
