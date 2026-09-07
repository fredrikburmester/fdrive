import type { z } from "zod";
import { AboutResponse } from "./about.ts";
import {
  AccountFavoritesResponse,
  AccountSearchResponse,
  type LinkIdentityRequest,
} from "./accounts.ts";
import { AdminConnectionResponse, type AdminConnectionUpdateRequest } from "./admin.ts";
import { type IdentitySummary, type LoginRequest, MeResponse } from "./auth.ts";
import { ApiError, type ApiErrorKind } from "./error.ts";
import {
  ArchiveEntriesResponse,
  type CompressRequest,
  type DeleteRequest,
  EntryResponse,
  type ExtractRequest,
  FolderSizeResponse,
  type FsEntry,
  ListResponse,
  OkResponse,
} from "./fs.ts";
import { JobAccepted, JobStatus, JobsResponse } from "./jobs.ts";
import {
  type CreateTagRequest,
  type FavoriteRequest,
  FavoritesResponse,
  RecentsResponse,
  type RecentTouchRequest,
  type SetFileTagsRequest,
  Tag,
  TagFilesResponse,
  TagsResponse,
  type UpdateTagRequest,
} from "./metadata.ts";
import {
  type OfficeCreateDocumentRequest,
  OfficeCreateDocumentResponse,
  type OfficeOpenRequest,
  OfficeOpenResponse,
  OfficeStatusResponse,
} from "./office.ts";
import {
  accountTokenRoute,
  IDENTITY_HEADER,
  identityScopeRoute,
  jobCancelRoute,
  jobRoute,
  MODIFIED_AT_HEADER,
  publicShareRoute,
  ROUTES,
  shareRoute,
  tagFilesRoute,
  tagRoute,
} from "./routes.ts";
import { IdentityScopeResponse, type SetIdentityScopeRequest } from "./scopes.ts";
import { SearchResponse, SearchStatusResponse } from "./search.ts";
import {
  ConnectionTestResponse,
  SETUP_TOKEN_HEADER,
  type SetupCompleteRequest,
  SetupStatusResponse,
} from "./setup.ts";
import {
  type CreateShareRequest,
  ManagedShare,
  PublicShare,
  ShareEntriesResponse,
  SharesResponse,
  type UpdateShareRequest,
} from "./shares.ts";
import {
  IndexerActionResponse,
  type IndexerClearRequest,
  IndexerClearResponse,
  type IndexerReindexRequest,
  IndexerSettingsResponse,
  type IndexerSettingsUpdateRequest,
  type IndexerThumbnailsRebuildRequest,
  IndexerThumbnailsRebuildResponse,
  OcrRunResponse,
  OcrSettingsResponse,
  type OcrSettingsUpdateRequest,
  SystemIndexerResponse,
  SystemOcrResponse,
  SystemReembedResponse,
  SystemSearchResponse,
  SystemThumbnailsResponse,
} from "./system.ts";
import type { ThumbSize } from "./thumbs.ts";
import { ApiTokensResponse, type CreateApiTokenRequest, CreateApiTokenResponse } from "./tokens.ts";
import {
  TrashListResponse,
  type TrashPurgeRequest,
  type TrashRestoreRequest,
  TrashRestoreResponse,
  TrashStatusResponse,
} from "./trash.ts";

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

/** Optional filters and paging for `ApiClient.search`, mirroring `SearchQuery` minus `q`. */
export interface ApiClientSearchOptions {
  limit?: number;
  ext?: string;
  folder?: string;
  after?: string;
  before?: string;
}

export interface ApiClient {
  listShares(): Promise<SharesResponse>;
  createShare(input: CreateShareRequest): Promise<ManagedShare>;
  getShare(id: string): Promise<ManagedShare>;
  updateShare(id: string, input: UpdateShareRequest): Promise<ManagedShare>;
  deleteShare(id: string): Promise<OkResponse>;
  publicShare(id: string): Promise<PublicShare>;
  setSharePassword(id: string, password: string): Promise<OkResponse>;
  clearSharePassword(id: string): Promise<OkResponse>;
  shareEntries(id: string, path?: string): Promise<ShareEntriesResponse>;
  /** Lists an archive's entries through a public share, without extracting it. */
  shareArchiveEntries(id: string, path?: string): Promise<ArchiveEntriesResponse>;
  shareDownloadUrl(id: string, path?: string): string;
  shareArchiveUrl(id: string): string;
  /** A public gallery tile's thumbnail: never counts as a download, unlike `shareDownloadUrl`. */
  shareThumbUrl(id: string, path: string, size: ThumbSize): string;
  shareUpload(
    id: string,
    path: string,
    body: UploadBody,
    signal?: AbortSignal,
  ): Promise<OkResponse>;
  officeStatus(): Promise<OfficeStatusResponse>;
  officeOpen(req: OfficeOpenRequest): Promise<OfficeOpenResponse>;
  officeCreateDocument(req: OfficeCreateDocumentRequest): Promise<OfficeCreateDocumentResponse>;
  login(req: LoginRequest): Promise<MeResponse>;
  logout(): Promise<OkResponse>;
  me(): Promise<MeResponse>;
  linkIdentity(input: LinkIdentityRequest): Promise<MeResponse>;
  unlinkIdentity(id: string): Promise<MeResponse>;
  switchIdentity(id: string): Promise<MeResponse>;
  accountFavorites(): Promise<AccountFavoritesResponse>;
  accountSearch(query: string, opts?: ApiClientSearchOptions): Promise<AccountSearchResponse>;
  /** The identity's scope mapping and index-availability status; 404 for an unknown or unowned id. */
  identityScope(id: string): Promise<IdentityScopeResponse>;
  /** Admin + CSRF only: replaces the identity's scope override. `{ scopes: [] }` resets it to the template-derived home scope. */
  setIdentityScope(id: string, body: SetIdentityScopeRequest): Promise<IdentityScopeResponse>;
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
  duplicate(path: string): Promise<FsEntry>;
  compress(req: CompressRequest): Promise<JobAccepted>;
  extract(req: ExtractRequest): Promise<JobAccepted>;
  /** Lists an archive's entries without extracting it. */
  archiveEntries(path: string): Promise<ArchiveEntriesResponse>;
  /** A directory's total size, computed from the index only. */
  folderSize(path: string): Promise<FolderSizeResponse>;
  jobs(): Promise<JobStatus[]>;
  job(id: string): Promise<JobStatus>;
  cancelJob(id: string): Promise<JobStatus>;
  about(): Promise<AboutResponse>;
  search(query: string, opts?: ApiClientSearchOptions): Promise<SearchResponse>;
  searchStatus(): Promise<SearchStatusResponse>;
  thumbUrl(path: string, size: ThumbSize): string;
  setupStatus(): Promise<SetupStatusResponse>;
  setupTest(setupToken: string, baseUrl: string): Promise<ConnectionTestResponse>;
  setupComplete(setupToken: string, req: SetupCompleteRequest): Promise<MeResponse>;
  adminConnection(): Promise<AdminConnectionResponse>;
  adminUpdateConnection(patch: AdminConnectionUpdateRequest): Promise<AdminConnectionResponse>;
  adminTestConnection(baseUrl?: string): Promise<ConnectionTestResponse>;
  systemClearIndex(req?: IndexerClearRequest): Promise<IndexerClearResponse>;
  systemClearThumbnails(): Promise<IndexerClearResponse>;
  systemIndexer(): Promise<SystemIndexerResponse>;
  systemUpdateIndexerSettings(
    settings: IndexerSettingsUpdateRequest,
  ): Promise<IndexerSettingsResponse>;
  systemReindex(req: IndexerReindexRequest): Promise<IndexerActionResponse>;
  systemRebuildIndexerThumbnails(
    req?: IndexerThumbnailsRebuildRequest,
  ): Promise<IndexerThumbnailsRebuildResponse>;
  systemSearch(): Promise<SystemSearchResponse>;
  systemReembed(): Promise<SystemReembedResponse>;
  systemOcr(): Promise<SystemOcrResponse>;
  systemUpdateOcrSettings(settings: OcrSettingsUpdateRequest): Promise<OcrSettingsResponse>;
  systemRunOcr(): Promise<OcrRunResponse>;
  systemThumbnails(): Promise<SystemThumbnailsResponse>;
  systemRebuildThumbnails(): Promise<IndexerThumbnailsRebuildResponse>;
  listApiTokens(): Promise<ApiTokensResponse>;
  createApiToken(req: CreateApiTokenRequest): Promise<CreateApiTokenResponse>;
  revokeApiToken(id: string): Promise<OkResponse>;
  listTags(): Promise<TagsResponse>;
  createTag(req: CreateTagRequest): Promise<Tag>;
  updateTag(id: string, req: UpdateTagRequest): Promise<Tag>;
  deleteTag(id: string): Promise<OkResponse>;
  tagFiles(id: string): Promise<TagFilesResponse>;
  setFileTags(req: SetFileTagsRequest): Promise<OkResponse>;
  listFavorites(): Promise<FavoritesResponse>;
  addFavorite(req: FavoriteRequest): Promise<OkResponse>;
  removeFavorite(req: FavoriteRequest): Promise<OkResponse>;
  listRecents(): Promise<RecentsResponse>;
  touchRecent(req: RecentTouchRequest): Promise<OkResponse>;
  trashStatus(): Promise<TrashStatusResponse>;
  trashList(): Promise<TrashListResponse>;
  trashRestore(req: TrashRestoreRequest): Promise<TrashRestoreResponse>;
  trashPurge(req: TrashPurgeRequest): Promise<OkResponse>;
  trashEmpty(): Promise<OkResponse>;
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
    listShares() {
      return requestJson(ctx, { method: "GET", path: ROUTES.shares }, SharesResponse);
    },
    createShare(input) {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.shares, jsonBody: input },
        ManagedShare,
      );
    },
    getShare(id) {
      return requestJson(ctx, { method: "GET", path: shareRoute(id) }, ManagedShare);
    },
    updateShare(id, input) {
      return requestJson(
        ctx,
        { method: "PATCH", path: shareRoute(id), jsonBody: input },
        ManagedShare,
      );
    },
    deleteShare(id) {
      return requestJson(ctx, { method: "DELETE", path: shareRoute(id) }, OkResponse);
    },
    publicShare(id) {
      return requestJson(ctx, { method: "GET", path: publicShareRoute(id) }, PublicShare);
    },
    setSharePassword(id, password) {
      return requestJson(
        ctx,
        { method: "POST", path: `${publicShareRoute(id)}/credentials`, jsonBody: { password } },
        OkResponse,
      );
    },
    clearSharePassword(id) {
      return requestJson(
        ctx,
        { method: "DELETE", path: `${publicShareRoute(id)}/credentials` },
        OkResponse,
      );
    },
    shareEntries(id, path = "/") {
      return requestJson(
        ctx,
        { method: "GET", path: `${publicShareRoute(id)}/entries`, query: { path } },
        ShareEntriesResponse,
      );
    },
    shareArchiveEntries(id, path = "/") {
      return requestJson(
        ctx,
        { method: "GET", path: `${publicShareRoute(id)}/archive-entries`, query: { path } },
        ArchiveEntriesResponse,
      );
    },
    shareDownloadUrl(id, path = "/") {
      return buildRequestUrl(ctx.baseUrl, `${publicShareRoute(id)}/download`, { path });
    },
    shareArchiveUrl(id) {
      return buildRequestUrl(ctx.baseUrl, `${publicShareRoute(id)}/archive`);
    },
    shareThumbUrl(id, path, size) {
      return buildRequestUrl(ctx.baseUrl, `${publicShareRoute(id)}/thumb`, {
        path,
        size: String(size),
      });
    },
    shareUpload(id, path, body, signal) {
      return requestJson(
        ctx,
        {
          method: "PUT",
          path: `${publicShareRoute(id)}/upload`,
          query: { path },
          rawBody: body,
          signal,
        },
        OkResponse,
      );
    },
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

    linkIdentity(input) {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.account.identities, jsonBody: input },
        MeResponse,
      );
    },
    unlinkIdentity(id) {
      return requestJson(
        ctx,
        { method: "DELETE", path: `${ROUTES.account.identities}/${encodeURIComponent(id)}` },
        MeResponse,
      );
    },
    switchIdentity(id) {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.account.activeIdentity, jsonBody: { identityId: id } },
        MeResponse,
      );
    },
    accountFavorites() {
      return requestJson(
        ctx,
        { method: "GET", path: ROUTES.account.favorites },
        AccountFavoritesResponse,
      );
    },
    identityScope(id) {
      return requestJson(
        ctx,
        { method: "GET", path: identityScopeRoute(id) },
        IdentityScopeResponse,
      );
    },
    setIdentityScope(id, body) {
      return requestJson(
        ctx,
        { method: "PUT", path: identityScopeRoute(id), jsonBody: body },
        IdentityScopeResponse,
      );
    },
    accountSearch(query, opts) {
      return requestJson(
        ctx,
        {
          method: "GET",
          path: ROUTES.account.search,
          query: {
            q: query,
            limit: opts?.limit === undefined ? undefined : String(opts.limit),
            ext: opts?.ext,
            folder: opts?.folder,
            after: opts?.after,
            before: opts?.before,
          },
        },
        AccountSearchResponse,
      );
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
        identity: ctx.identityId,
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

    duplicate(path: string): Promise<FsEntry> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.fs.duplicate, jsonBody: { path } },
        EntryResponse,
      );
    },

    compress(req: CompressRequest): Promise<JobAccepted> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.fs.compress, jsonBody: req },
        JobAccepted,
      );
    },

    extract(req: ExtractRequest): Promise<JobAccepted> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.fs.extract, jsonBody: req },
        JobAccepted,
      );
    },

    archiveEntries(path: string): Promise<ArchiveEntriesResponse> {
      return requestJson(
        ctx,
        { method: "GET", path: ROUTES.fs.archiveEntries, query: { path } },
        ArchiveEntriesResponse,
      );
    },

    folderSize(path: string): Promise<FolderSizeResponse> {
      return requestJson(
        ctx,
        { method: "GET", path: ROUTES.fs.folderSize, query: { path } },
        FolderSizeResponse,
      );
    },

    async jobs(): Promise<JobStatus[]> {
      const res = await requestJson(ctx, { method: "GET", path: ROUTES.fs.jobs }, JobsResponse);
      return res.jobs;
    },

    job(id: string): Promise<JobStatus> {
      return requestJson(ctx, { method: "GET", path: jobRoute(id) }, JobStatus);
    },

    cancelJob(id: string): Promise<JobStatus> {
      return requestJson(ctx, { method: "POST", path: jobCancelRoute(id) }, JobStatus);
    },

    about(): Promise<AboutResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.about }, AboutResponse);
    },

    search(query: string, opts?: ApiClientSearchOptions): Promise<SearchResponse> {
      return requestJson(
        ctx,
        {
          method: "GET",
          path: ROUTES.search.query,
          query: {
            q: query,
            limit: opts?.limit === undefined ? undefined : String(opts.limit),
            ext: opts?.ext,
            folder: opts?.folder,
            after: opts?.after,
            before: opts?.before,
          },
        },
        SearchResponse,
      );
    },

    searchStatus(): Promise<SearchStatusResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.search.status }, SearchStatusResponse);
    },

    thumbUrl(path: string, size: ThumbSize): string {
      return buildRequestUrl(ctx.baseUrl, ROUTES.thumb, { path, size: String(size) });
    },

    setupStatus(): Promise<SetupStatusResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.setup.status }, SetupStatusResponse);
    },

    setupTest(setupToken: string, baseUrl: string): Promise<ConnectionTestResponse> {
      return requestJson(
        ctx,
        {
          method: "POST",
          path: ROUTES.setup.test,
          jsonBody: { baseUrl },
          extraHeaders: { [SETUP_TOKEN_HEADER]: setupToken },
        },
        ConnectionTestResponse,
      );
    },

    setupComplete(setupToken: string, req: SetupCompleteRequest): Promise<MeResponse> {
      return requestJson(
        ctx,
        {
          method: "POST",
          path: ROUTES.setup.complete,
          jsonBody: req,
          extraHeaders: { [SETUP_TOKEN_HEADER]: setupToken },
        },
        MeResponse,
      );
    },

    adminConnection(): Promise<AdminConnectionResponse> {
      return requestJson(
        ctx,
        { method: "GET", path: ROUTES.admin.connection },
        AdminConnectionResponse,
      );
    },

    adminUpdateConnection(patch: AdminConnectionUpdateRequest): Promise<AdminConnectionResponse> {
      return requestJson(
        ctx,
        { method: "PUT", path: ROUTES.admin.connectionUpdate, jsonBody: patch },
        AdminConnectionResponse,
      );
    },

    adminTestConnection(baseUrl?: string): Promise<ConnectionTestResponse> {
      return requestJson(
        ctx,
        {
          method: "POST",
          path: ROUTES.admin.connectionTest,
          jsonBody: baseUrl !== undefined ? { baseUrl } : {},
        },
        ConnectionTestResponse,
      );
    },

    systemIndexer(): Promise<SystemIndexerResponse> {
      return requestJson(
        ctx,
        { method: "GET", path: ROUTES.system.indexer },
        SystemIndexerResponse,
      );
    },

    systemUpdateIndexerSettings(
      settings: IndexerSettingsUpdateRequest,
    ): Promise<IndexerSettingsResponse> {
      return requestJson(
        ctx,
        { method: "PUT", path: ROUTES.system.indexerSettings, jsonBody: settings },
        IndexerSettingsResponse,
      );
    },

    systemClearIndex(req?: IndexerClearRequest): Promise<IndexerClearResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.system.indexerClear, jsonBody: req ?? {} },
        IndexerClearResponse,
      );
    },

    systemClearThumbnails(): Promise<IndexerClearResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.system.thumbnailsClear, jsonBody: {} },
        IndexerClearResponse,
      );
    },

    systemReindex(req: IndexerReindexRequest): Promise<IndexerActionResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.system.indexerReindex, jsonBody: req },
        IndexerActionResponse,
      );
    },

    systemRebuildIndexerThumbnails(
      req?: IndexerThumbnailsRebuildRequest,
    ): Promise<IndexerThumbnailsRebuildResponse> {
      return requestJson(
        ctx,
        {
          method: "POST",
          path: ROUTES.system.indexerThumbnailsRebuild,
          jsonBody: req ?? {},
        },
        IndexerThumbnailsRebuildResponse,
      );
    },

    systemSearch(): Promise<SystemSearchResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.system.search }, SystemSearchResponse);
    },

    systemReembed(): Promise<SystemReembedResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.system.searchReembed },
        SystemReembedResponse,
      );
    },

    systemOcr(): Promise<SystemOcrResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.system.ocr }, SystemOcrResponse);
    },

    systemUpdateOcrSettings(settings: OcrSettingsUpdateRequest): Promise<OcrSettingsResponse> {
      return requestJson(
        ctx,
        { method: "PUT", path: ROUTES.system.ocrSettings, jsonBody: settings },
        OcrSettingsResponse,
      );
    },

    systemRunOcr(): Promise<OcrRunResponse> {
      return requestJson(ctx, { method: "POST", path: ROUTES.system.ocrRun }, OcrRunResponse);
    },

    systemThumbnails(): Promise<SystemThumbnailsResponse> {
      return requestJson(
        ctx,
        { method: "GET", path: ROUTES.system.thumbnails },
        SystemThumbnailsResponse,
      );
    },

    systemRebuildThumbnails(): Promise<IndexerThumbnailsRebuildResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.system.thumbnailsRebuild },
        IndexerThumbnailsRebuildResponse,
      );
    },

    officeStatus() {
      return requestJson(ctx, { method: "GET", path: ROUTES.office.status }, OfficeStatusResponse);
    },
    officeOpen(req) {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.office.open, jsonBody: req },
        OfficeOpenResponse,
      );
    },
    officeCreateDocument(req) {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.office.documents, jsonBody: req },
        OfficeCreateDocumentResponse,
      );
    },
    listApiTokens(): Promise<ApiTokensResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.account.tokens }, ApiTokensResponse);
    },

    createApiToken(req: CreateApiTokenRequest): Promise<CreateApiTokenResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.account.tokens, jsonBody: req },
        CreateApiTokenResponse,
      );
    },

    revokeApiToken(id: string): Promise<OkResponse> {
      return requestJson(ctx, { method: "DELETE", path: accountTokenRoute(id) }, OkResponse);
    },

    listTags(): Promise<TagsResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.tags }, TagsResponse);
    },

    createTag(req: CreateTagRequest): Promise<Tag> {
      return requestJson(ctx, { method: "POST", path: ROUTES.tags, jsonBody: req }, Tag);
    },

    updateTag(id: string, req: UpdateTagRequest): Promise<Tag> {
      return requestJson(ctx, { method: "PATCH", path: tagRoute(id), jsonBody: req }, Tag);
    },

    deleteTag(id: string): Promise<OkResponse> {
      return requestJson(ctx, { method: "DELETE", path: tagRoute(id) }, OkResponse);
    },

    tagFiles(id: string): Promise<TagFilesResponse> {
      return requestJson(ctx, { method: "GET", path: tagFilesRoute(id) }, TagFilesResponse);
    },

    setFileTags(req: SetFileTagsRequest): Promise<OkResponse> {
      return requestJson(ctx, { method: "PUT", path: ROUTES.fs.tags, jsonBody: req }, OkResponse);
    },

    listFavorites(): Promise<FavoritesResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.favorites.base }, FavoritesResponse);
    },

    addFavorite(req: FavoriteRequest): Promise<OkResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.favorites.base, jsonBody: req },
        OkResponse,
      );
    },

    removeFavorite(req: FavoriteRequest): Promise<OkResponse> {
      return requestJson(
        ctx,
        { method: "DELETE", path: ROUTES.favorites.base, jsonBody: req },
        OkResponse,
      );
    },

    listRecents(): Promise<RecentsResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.recents.list }, RecentsResponse);
    },

    touchRecent(req: RecentTouchRequest): Promise<OkResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.recents.touch, jsonBody: req },
        OkResponse,
      );
    },

    trashStatus(): Promise<TrashStatusResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.trash.status }, TrashStatusResponse);
    },

    trashList(): Promise<TrashListResponse> {
      return requestJson(ctx, { method: "GET", path: ROUTES.trash.list }, TrashListResponse);
    },

    trashRestore(req: TrashRestoreRequest): Promise<TrashRestoreResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.trash.restore, jsonBody: req },
        TrashRestoreResponse,
      );
    },

    trashPurge(req: TrashPurgeRequest): Promise<OkResponse> {
      return requestJson(
        ctx,
        { method: "POST", path: ROUTES.trash.purge, jsonBody: req },
        OkResponse,
      );
    },

    trashEmpty(): Promise<OkResponse> {
      return requestJson(ctx, { method: "POST", path: ROUTES.trash.empty }, OkResponse);
    },
  };
}
