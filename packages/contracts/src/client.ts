import type { z } from "zod";
import { AboutResponse } from "./about.ts";
import { type IdentitySummary, type LoginRequest, MeResponse } from "./auth.ts";
import { ApiError, type ApiErrorKind } from "./error.ts";
import { type DeleteRequest, EntryResponse, type FsEntry, ListResponse, OkResponse } from "./fs.ts";
import { IDENTITY_HEADER, MODIFIED_AT_HEADER, ROUTES } from "./routes.ts";

export type { IdentitySummary };

/**
 * Thrown by every `ApiClient` method when the request fails, whether the
 * API returned a well-formed `ApiError` body, an unparseable error
 * response, a response that failed contract validation, or the network
 * request itself failed.
 */
export class ApiClientError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    kind: ApiErrorKind,
    message: string,
    status: number,
    opts?: { requestId?: string | undefined; details?: Record<string, unknown> | undefined },
  ) {
    super(message);
    this.name = "ApiClientError";
    this.kind = kind;
    this.status = status;
    this.requestId = opts?.requestId;
    this.details = opts?.details;
  }
}

export interface ApiClientOptions {
  /** Prefixed to every route path. Defaults to "" (same-origin, relative). */
  baseUrl?: string;
  /** Defaults to `globalThis.fetch`. Override in tests with a stub. */
  fetch?: typeof globalThis.fetch;
  /** Sent as the `x-identity-id` header on every request, when set. */
  identityId?: string;
}

export interface ApiClientUploadOptions {
  mkdirParents?: boolean;
  modifiedAt?: Date;
  contentLength?: number;
  signal?: AbortSignal;
}

export type UploadBody = Blob | ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>;

export interface ApiClient {
  login(req: LoginRequest): Promise<MeResponse>;
  logout(): Promise<OkResponse>;
  me(): Promise<MeResponse>;
  list(path: string): Promise<ListResponse>;
  stat(path: string): Promise<FsEntry>;
  mkdir(path: string): Promise<FsEntry>;
  move(path: string, target: string): Promise<FsEntry>;
  copy(path: string, target: string): Promise<FsEntry>;
  rename(path: string, newName: string): Promise<FsEntry>;
  remove(items: DeleteRequest["items"]): Promise<OkResponse>;
  zip(paths: string[], name?: string): Promise<Response>;
  downloadUrl(path: string, opts?: { inline?: boolean }): string;
  upload(path: string, body: UploadBody, opts?: ApiClientUploadOptions): Promise<FsEntry>;
  about(): Promise<AboutResponse>;
}

interface ClientContext {
  readonly baseUrl: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly identityId: string | undefined;
}

/** HTTP methods that mutate state and therefore need the CSRF marker header. */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type QueryValue = string | undefined;

/**
 * Serializes `query` into a leading-`?` query string, omitting keys whose
 * value is `undefined`. Returns "" when there is nothing to serialize.
 */
export function toQueryString(query: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, value);
    }
  }
  const serialized = params.toString();
  return serialized.length > 0 ? `?${serialized}` : "";
}

/**
 * Builds the full request URL for `path` under `baseUrl`, appending
 * `query` as a query string when given.
 */
export function buildRequestUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const qs = query !== undefined ? toQueryString(query) : "";
  return `${baseUrl}${path}${qs}`;
}

interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, QueryValue>;
  jsonBody?: unknown;
  rawBody?: UploadBody;
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal | undefined;
}

type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

/**
 * The type `fetch`'s own `RequestInit.body` accepts. Derived by indexed
 * access rather than referencing the ambient `BodyInit` name directly,
 * because that name only exists when the DOM lib is loaded; deriving it
 * this way keeps this module compiling both in the browser (DOM lib) and
 * in plain Node (no DOM lib, `@types/node`'s own fetch types).
 */
type FetchRequestBody = NonNullable<RequestInit["body"]>;

async function rawRequest(ctx: ClientContext, opts: RequestOptions): Promise<Response> {
  const url = buildRequestUrl(ctx.baseUrl, opts.path, opts.query);
  const headers = new Headers(opts.extraHeaders);

  if (ctx.identityId !== undefined) {
    headers.set(IDENTITY_HEADER, ctx.identityId);
  }
  if (STATE_CHANGING_METHODS.has(opts.method)) {
    headers.set("x-requested-with", "fdrive");
  }

  let body: FetchRequestBody | undefined;
  if (opts.jsonBody !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.jsonBody);
  } else if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  }

  const init: RequestInitWithDuplex = {
    method: opts.method,
    headers,
    credentials: "include",
    ...(body !== undefined ? { body } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
  if (body instanceof ReadableStream) {
    init.duplex = "half";
  }

  try {
    // Never call this as `ctx.fetchImpl(...)`: that member-expression call
    // syntax binds `this` to `ctx`, and native `fetch` throws
    // `TypeError: Illegal invocation` in browsers when invoked with a
    // `this` other than `window` (or undefined). Extracting the function
    // reference first makes this a plain call, so `this` is `undefined`.
    const fetchImpl = ctx.fetchImpl;
    return await fetchImpl(url, init);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "network request failed";
    throw new ApiClientError("upstream_unavailable", message, 0);
  }
}

/**
 * Turns a non-2xx `Response` into an `ApiClientError`, using the body's
 * `ApiError` shape when present and falling back to a generic `internal`
 * error otherwise.
 */
async function toApiClientError(res: Response): Promise<ApiClientError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return new ApiClientError("internal", `request failed with status ${res.status}`, res.status);
  }

  const parsed = ApiError.safeParse(body);
  if (!parsed.success) {
    return new ApiClientError("internal", `request failed with status ${res.status}`, res.status);
  }

  const { kind, message, requestId, details } = parsed.data.error;
  return new ApiClientError(kind, message, res.status, { requestId, details });
}

async function parseJsonResponse<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  if (!res.ok) {
    throw await toApiClientError(res);
  }

  const data: unknown = await res.json();
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiClientError("internal", "response failed contract validation", res.status, {
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}

async function requestJson<T>(
  ctx: ClientContext,
  opts: RequestOptions,
  schema: z.ZodType<T>,
): Promise<T> {
  const res = await rawRequest(ctx, opts);
  return parseJsonResponse(res, schema);
}

/**
 * Builds a typed, browser-safe fdrive API client. Every JSON response is
 * validated against its `@fdrive/contracts` schema; failures and non-2xx
 * responses throw `ApiClientError`. All requests send credentials, and
 * state-changing requests (POST/PUT/PATCH/DELETE) send the
 * `x-requested-with: fdrive` marker the API's CSRF guard requires.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const ctx: ClientContext = {
    baseUrl: options.baseUrl ?? "",
    fetchImpl: options.fetch ?? globalThis.fetch,
    identityId: options.identityId,
  };

  return {
    login(req: LoginRequest): Promise<MeResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.auth.login, jsonBody: req },
        MeResponse,
      );
    },

    logout(): Promise<OkResponse> {
      return requestJson(ctx, { method: "POST", path: ROUTES.auth.logout }, OkResponse);
    },

    me(): Promise<MeResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.auth.me }, MeResponse);
    },

    list(path: string): Promise<ListResponse> {
      return requestJson(
        ctx,
        { method: "GET", path: ROUTES.fs.list, query: { path } },
        ListResponse,
      );
    },

    stat(path: string): Promise<FsEntry> {
      return requestJson(
        ctx,
        { method: "GET", path: ROUTES.fs.stat, query: { path } },
        EntryResponse,
      );
    },

    mkdir(path: string): Promise<FsEntry> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.fs.mkdir, jsonBody: { path } },
        EntryResponse,
      );
    },

    move(path: string, target: string): Promise<FsEntry> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.fs.move, jsonBody: { path, target } },
        EntryResponse,
      );
    },

    copy(path: string, target: string): Promise<FsEntry> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.fs.copy, jsonBody: { path, target } },
        EntryResponse,
      );
    },

    rename(path: string, newName: string): Promise<FsEntry> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.fs.rename, jsonBody: { path, newName } },
        EntryResponse,
      );
    },

    remove(items: DeleteRequest["items"]): Promise<OkResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.fs.delete, jsonBody: { items } },
        OkResponse,
      );
    },

    zip(paths: string[], name?: string): Promise<Response> {
      return rawRequest(ctx, {
        method: "POST",
        path: ROUTES.fs.zip,
        jsonBody: name !== undefined ? { paths, name } : { paths },
      });
    },

    downloadUrl(path: string, opts?: { inline?: boolean }): string {
      return buildRequestUrl(ctx.baseUrl, ROUTES.fs.download, {
        path,
        inline: opts?.inline === true ? "1" : undefined,
      });
    },

    upload(path: string, body: UploadBody, opts?: ApiClientUploadOptions): Promise<FsEntry> {
      const extraHeaders: Record<string, string> = {};
      if (opts?.modifiedAt !== undefined) {
        extraHeaders[MODIFIED_AT_HEADER] = String(opts.modifiedAt.getTime());
      }
      if (opts?.contentLength !== undefined) {
        extraHeaders["content-length"] = String(opts.contentLength);
      }

      return requestJson(
        ctx,
        {
          method: "PUT",
          path: ROUTES.fs.upload,
          query: {
            path,
            mkdirParents:
              opts?.mkdirParents === undefined ? undefined : opts.mkdirParents ? "true" : "false",
          },
          rawBody: body,
          extraHeaders,
          signal: opts?.signal,
        },
        EntryResponse,
      );
    },

    about(): Promise<AboutResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.about }, AboutResponse);
    },
  };
}
