import type { z } from "zod";
import { AboutResponse } from "./about.ts";
import {
  AccountFavoritesResponse,
  AccountSearchResponse,
  type LinkIdentityRequest,
  type UnlinkIdentityRequest,
} from "./accounts.ts";
import { type IdentitySummary, type LoginRequest, MeResponse } from "./auth.ts";
import { ApiError, type ApiErrorKind } from "./error.ts";
import { type FeaturesUpdateRequest, SystemFeaturesResponse } from "./features.ts";
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
  FolderViewResponse,
  RecentsResponse,
  type RecentTouchRequest,
  type RemoveFolderViewRequest,
  type SetFileTagsRequest,
  type SetFolderViewRequest,
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
  type OfficeSettingsUpdateRequest,
  OfficeStatusResponse,
  SystemOfficeResponse,
} from "./office.ts";
import {
  AdminProvider,
  type AdminProviderCreateRequest,
  AdminProvidersResponse,
  type AdminProviderTestRequest,
  type AdminProviderUpdateRequest,
  ProvidersResponse,
} from "./providers.ts";
import { PublicUrlSettings, type PublicUrlUpdateRequest } from "./public-url.ts";
import {
  accountTokenRoute,
  adminProviderRoute,
  adminProviderTestRoute,
  IDENTITY_HEADER,
  identityScopeRoute,
  identityScopeSuggestionsRoute,
  jobCancelRoute,
  jobRoute,
  MODIFIED_AT_HEADER,
  publicShareRoute,
  ROUTES,
  shareRoute,
  systemLogsRoute,
  tagFilesRoute,
  tagRoute,
} from "./routes.ts";
import {
  IdentityScopeResponse,
  IdentityScopeSuggestionsResponse,
  MountMappingsResponse,
  type SetIdentityScopeRequestInput,
  type SetMountMappingsRequest,
} from "./scopes.ts";
import { ImageSearchResponse, SearchResponse, SearchStatusResponse } from "./search.ts";
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
  SystemImageSearchResponse,
  SystemIndexerResponse,
  type SystemLogLevel,
  type SystemLogSubsystem,
  SystemLogsResponse,
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
  TrashSettings,
  type TrashSettingsUpdateRequest,
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

/** Optional paging for `ApiClient.searchImages`, mirroring `ImageSearchQuery` minus `q`. */
export interface ApiClientImageSearchOptions {
  limit?: number;
}

export interface ApiClient {
  systemFeatures(): Promise<SystemFeaturesResponse>;
  systemUpdateFeatures(input: FeaturesUpdateRequest): Promise<SystemFeaturesResponse>;
  systemPublicUrl(): Promise<PublicUrlSettings>;
  systemUpdatePublicUrl(input: PublicUrlUpdateRequest): Promise<PublicUrlSettings>;
  systemOffice(): Promise<SystemOfficeResponse>;
  systemUpdateOffice(input: OfficeSettingsUpdateRequest): Promise<SystemOfficeResponse>;
  systemTrash(): Promise<TrashSettings>;
  systemUpdateTrash(input: TrashSettingsUpdateRequest): Promise<TrashSettings>;
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
  unlinkIdentity(id: string, input: UnlinkIdentityRequest): Promise<MeResponse>;
  switchIdentity(id: string): Promise<MeResponse>;
  accountFavorites(): Promise<AccountFavoritesResponse>;
  accountSearch(query: string, opts?: ApiClientSearchOptions): Promise<AccountSearchResponse>;
  /** The identity's scope mapping and index-availability status; 404 for an unknown or unowned id. */
  identityScope(id: string): Promise<IdentityScopeResponse>;
  /** Admin + CSRF only: replaces the identity's scope override. `{ scopes: [] }` resets it to the template-derived home scope. */
  setIdentityScope(id: string, body: SetIdentityScopeRequestInput): Promise<IdentityScopeResponse>;
  /** Admin only: confirmed candidate locations for each of the identity's unmapped mounts. */
  identityScopeSuggestions(id: string): Promise<IdentityScopeSuggestionsResponse>;
  /** Admin only: the folder-level virtual folder mappings. */
  mountMappings(): Promise<MountMappingsResponse>;
  /** Admin + CSRF only: replaces the folder-level mappings. */
  setMountMappings(body: SetMountMappingsRequest): Promise<MountMappingsResponse>;
  list(path: string): Promise<ListResponse>;
  stat(path: string, signal?: AbortSignal): Promise<FsEntry>;
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
  searchImages(query: string, opts?: ApiClientImageSearchOptions): Promise<ImageSearchResponse>;
  thumbUrl(path: string, size: ThumbSize): string;
  setupStatus(): Promise<SetupStatusResponse>;
  setupTest(setupToken: string, baseUrl: string): Promise<ConnectionTestResponse>;
  setupComplete(setupToken: string, req: SetupCompleteRequest): Promise<MeResponse>;
  /** Public: the enabled providers with their credential forms, for the login page. */
  providers(): Promise<ProvidersResponse>;
  adminProviders(): Promise<AdminProvidersResponse>;
  adminCreateProvider(req: AdminProviderCreateRequest): Promise<AdminProvider>;
  adminUpdateProvider(id: string, patch: AdminProviderUpdateRequest): Promise<AdminProvider>;
  adminDeleteProvider(id: string): Promise<OkResponse>;
  /** Probes a saved provider (`id`) or an unsaved candidate (`req`). */
  adminTestProvider(target: string | AdminProviderTestRequest): Promise<ConnectionTestResponse>;
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
  systemImageSearch(): Promise<SystemImageSearchResponse>;
  systemImageSearchRebuild(
    req?: IndexerThumbnailsRebuildRequest,
  ): Promise<IndexerThumbnailsRebuildResponse>;
  systemImageSearchClear(): Promise<IndexerClearResponse>;
  systemOcr(): Promise<SystemOcrResponse>;
  systemUpdateOcrSettings(settings: OcrSettingsUpdateRequest): Promise<OcrSettingsResponse>;
  systemRunOcr(): Promise<OcrRunResponse>;
  systemThumbnails(): Promise<SystemThumbnailsResponse>;
  systemRebuildThumbnails(): Promise<IndexerThumbnailsRebuildResponse>;
  /** One subsystem's event log, newest first. Admin only. */
  systemLogs(
    subsystem: SystemLogSubsystem,
    query?: { limit?: number; level?: SystemLogLevel; before?: string },
  ): Promise<SystemLogsResponse>;
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
  getFolderView(path: string): Promise<FolderViewResponse>;
  setFolderView(req: SetFolderViewRequest): Promise<OkResponse>;
  removeFolderView(req: RemoveFolderViewRequest): Promise<OkResponse>;
  resetFolderViews(): Promise<OkResponse>;
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

  const method =
    (verb: RequestOptions["method"]) =>
    <T>(path: string, schema: z.ZodType<T>, opts: Omit<RequestOptions, "method" | "path"> = {}) =>
      requestJson(ctx, { ...opts, method: verb, path }, schema);
  const get = method("GET");
  const post = method("POST");
  const patch = method("PATCH");
  const del = method("DELETE");
  const put = method("PUT");

  return {
    listShares() {
      return get(ROUTES.shares, SharesResponse);
    },
    createShare(input) {
      return post(ROUTES.shares, ManagedShare, { jsonBody: input });
    },
    getShare(id) {
      return get(shareRoute(id), ManagedShare);
    },
    updateShare(id, input) {
      return patch(shareRoute(id), ManagedShare, { jsonBody: input });
    },
    deleteShare(id) {
      return del(shareRoute(id), OkResponse);
    },
    publicShare(id) {
      return get(publicShareRoute(id), PublicShare);
    },
    setSharePassword(id, password) {
      return post(`${publicShareRoute(id)}/credentials`, OkResponse, { jsonBody: { password } });
    },
    clearSharePassword(id) {
      return del(`${publicShareRoute(id)}/credentials`, OkResponse);
    },
    shareEntries(id, path = "/") {
      return get(`${publicShareRoute(id)}/entries`, ShareEntriesResponse, { query: { path } });
    },
    shareArchiveEntries(id, path = "/") {
      return get(`${publicShareRoute(id)}/archive-entries`, ArchiveEntriesResponse, {
        query: { path },
      });
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
      return put(`${publicShareRoute(id)}/upload`, OkResponse, {
        query: { path },
        rawBody: body,
        signal,
      });
    },
    login(req: LoginRequest): Promise<MeResponse> {
      return post(ROUTES.auth.login, MeResponse, { jsonBody: req });
    },

    logout(): Promise<OkResponse> {
      return post(ROUTES.auth.logout, OkResponse);
    },

    linkIdentity(input) {
      return post(ROUTES.account.identities, MeResponse, { jsonBody: input });
    },
    unlinkIdentity(id, input) {
      return del(`${ROUTES.account.identities}/${encodeURIComponent(id)}`, MeResponse, {
        jsonBody: input,
      });
    },
    switchIdentity(id) {
      return post(ROUTES.account.activeIdentity, MeResponse, { jsonBody: { identityId: id } });
    },
    accountFavorites() {
      return get(ROUTES.account.favorites, AccountFavoritesResponse);
    },
    identityScope(id) {
      return get(identityScopeRoute(id), IdentityScopeResponse);
    },
    setIdentityScope(id, body) {
      return put(identityScopeRoute(id), IdentityScopeResponse, { jsonBody: body });
    },
    identityScopeSuggestions(id) {
      return get(identityScopeSuggestionsRoute(id), IdentityScopeSuggestionsResponse);
    },
    mountMappings() {
      return get(ROUTES.system.mountMappings, MountMappingsResponse);
    },
    setMountMappings(body) {
      return put(ROUTES.system.mountMappings, MountMappingsResponse, { jsonBody: body });
    },
    accountSearch(query, opts) {
      return get(ROUTES.account.search, AccountSearchResponse, {
        query: {
          q: query,
          limit: opts?.limit === undefined ? undefined : String(opts.limit),
          ext: opts?.ext,
          folder: opts?.folder,
          after: opts?.after,
          before: opts?.before,
        },
      });
    },

    me(): Promise<MeResponse> {
      return get(ROUTES.auth.me, MeResponse);
    },

    list(path: string): Promise<ListResponse> {
      return get(ROUTES.fs.list, ListResponse, { query: { path } });
    },

    stat(path: string, signal?: AbortSignal): Promise<FsEntry> {
      return get(ROUTES.fs.stat, EntryResponse, { query: { path }, signal });
    },

    mkdir(path: string): Promise<FsEntry> {
      return post(ROUTES.fs.mkdir, EntryResponse, { jsonBody: { path } });
    },

    move(path: string, target: string): Promise<FsEntry> {
      return post(ROUTES.fs.move, EntryResponse, { jsonBody: { path, target } });
    },

    copy(path: string, target: string): Promise<FsEntry> {
      return post(ROUTES.fs.copy, EntryResponse, { jsonBody: { path, target } });
    },

    rename(path: string, newName: string): Promise<FsEntry> {
      return post(ROUTES.fs.rename, EntryResponse, { jsonBody: { path, newName } });
    },

    remove(items: DeleteRequest["items"]): Promise<OkResponse> {
      return post(ROUTES.fs.delete, OkResponse, { jsonBody: { items } });
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

      return put(ROUTES.fs.upload, EntryResponse, {
        query: {
          path,
          mkdirParents:
            opts?.mkdirParents === undefined ? undefined : opts.mkdirParents ? "true" : "false",
        },
        rawBody: body,
        extraHeaders,
        signal: opts?.signal,
      });
    },

    duplicate(path: string): Promise<FsEntry> {
      return post(ROUTES.fs.duplicate, EntryResponse, { jsonBody: { path } });
    },

    compress(req: CompressRequest): Promise<JobAccepted> {
      return post(ROUTES.fs.compress, JobAccepted, { jsonBody: req });
    },

    extract(req: ExtractRequest): Promise<JobAccepted> {
      return post(ROUTES.fs.extract, JobAccepted, { jsonBody: req });
    },

    archiveEntries(path: string): Promise<ArchiveEntriesResponse> {
      return get(ROUTES.fs.archiveEntries, ArchiveEntriesResponse, { query: { path } });
    },

    folderSize(path: string): Promise<FolderSizeResponse> {
      return get(ROUTES.fs.folderSize, FolderSizeResponse, { query: { path } });
    },

    async jobs(): Promise<JobStatus[]> {
      const res = await get(ROUTES.fs.jobs, JobsResponse);
      return res.jobs;
    },

    job(id: string): Promise<JobStatus> {
      return get(jobRoute(id), JobStatus);
    },

    cancelJob(id: string): Promise<JobStatus> {
      return post(jobCancelRoute(id), JobStatus);
    },

    about(): Promise<AboutResponse> {
      return get(ROUTES.about, AboutResponse);
    },

    search(query: string, opts?: ApiClientSearchOptions): Promise<SearchResponse> {
      return get(ROUTES.search.query, SearchResponse, {
        query: {
          q: query,
          limit: opts?.limit === undefined ? undefined : String(opts.limit),
          ext: opts?.ext,
          folder: opts?.folder,
          after: opts?.after,
          before: opts?.before,
        },
      });
    },

    searchStatus(): Promise<SearchStatusResponse> {
      return get(ROUTES.search.status, SearchStatusResponse);
    },

    searchImages(query: string, opts?: ApiClientImageSearchOptions): Promise<ImageSearchResponse> {
      return get(ROUTES.search.images, ImageSearchResponse, {
        query: {
          q: query,
          limit: opts?.limit === undefined ? undefined : String(opts.limit),
        },
      });
    },

    thumbUrl(path: string, size: ThumbSize): string {
      return buildRequestUrl(ctx.baseUrl, ROUTES.thumb, { path, size: String(size) });
    },

    setupStatus(): Promise<SetupStatusResponse> {
      return get(ROUTES.setup.status, SetupStatusResponse);
    },

    setupTest(setupToken: string, baseUrl: string): Promise<ConnectionTestResponse> {
      return post(ROUTES.setup.test, ConnectionTestResponse, {
        jsonBody: { baseUrl },
        extraHeaders: { [SETUP_TOKEN_HEADER]: setupToken },
      });
    },

    setupComplete(setupToken: string, req: SetupCompleteRequest): Promise<MeResponse> {
      return post(ROUTES.setup.complete, MeResponse, {
        jsonBody: req,
        extraHeaders: { [SETUP_TOKEN_HEADER]: setupToken },
      });
    },

    providers: () => get(ROUTES.providers, ProvidersResponse),
    adminProviders: () => get(ROUTES.admin.providers, AdminProvidersResponse),
    adminCreateProvider: (req: AdminProviderCreateRequest) =>
      post(ROUTES.admin.providers, AdminProvider, { jsonBody: req }),
    adminUpdateProvider: (id: string, input: AdminProviderUpdateRequest) =>
      patch(adminProviderRoute(id), AdminProvider, { jsonBody: input }),
    adminDeleteProvider: (id: string) => del(adminProviderRoute(id), OkResponse),
    adminTestProvider: (target: string | AdminProviderTestRequest) =>
      requestJson(
        ctx,
        typeof target === "string"
          ? { method: "POST", path: adminProviderTestRoute(target) }
          : { method: "POST", path: ROUTES.admin.providersTest, jsonBody: target },
        ConnectionTestResponse,
      ),

    systemFeatures(): Promise<SystemFeaturesResponse> {
      return get(ROUTES.system.features, SystemFeaturesResponse);
    },
    systemUpdateFeatures(input: FeaturesUpdateRequest): Promise<SystemFeaturesResponse> {
      return put(ROUTES.system.features, SystemFeaturesResponse, { jsonBody: input });
    },
    systemPublicUrl(): Promise<PublicUrlSettings> {
      return get(ROUTES.system.publicUrl, PublicUrlSettings);
    },
    systemUpdatePublicUrl(input: PublicUrlUpdateRequest): Promise<PublicUrlSettings> {
      return put(ROUTES.system.publicUrl, PublicUrlSettings, { jsonBody: input });
    },
    systemOffice(): Promise<SystemOfficeResponse> {
      return get(ROUTES.system.office, SystemOfficeResponse);
    },
    systemUpdateOffice(input: OfficeSettingsUpdateRequest): Promise<SystemOfficeResponse> {
      return put(ROUTES.system.office, SystemOfficeResponse, { jsonBody: input });
    },
    systemTrash(): Promise<TrashSettings> {
      return get(ROUTES.system.trash, TrashSettings);
    },
    systemUpdateTrash(input: TrashSettingsUpdateRequest): Promise<TrashSettings> {
      return put(ROUTES.system.trash, TrashSettings, { jsonBody: input });
    },
    systemIndexer(): Promise<SystemIndexerResponse> {
      return get(ROUTES.system.indexer, SystemIndexerResponse);
    },

    systemUpdateIndexerSettings(
      settings: IndexerSettingsUpdateRequest,
    ): Promise<IndexerSettingsResponse> {
      return put(ROUTES.system.indexerSettings, IndexerSettingsResponse, { jsonBody: settings });
    },

    systemClearIndex(req?: IndexerClearRequest): Promise<IndexerClearResponse> {
      return post(ROUTES.system.indexerClear, IndexerClearResponse, { jsonBody: req ?? {} });
    },

    systemClearThumbnails(): Promise<IndexerClearResponse> {
      return post(ROUTES.system.thumbnailsClear, IndexerClearResponse, { jsonBody: {} });
    },

    systemReindex(req: IndexerReindexRequest): Promise<IndexerActionResponse> {
      return post(ROUTES.system.indexerReindex, IndexerActionResponse, { jsonBody: req });
    },

    systemRebuildIndexerThumbnails(
      req?: IndexerThumbnailsRebuildRequest,
    ): Promise<IndexerThumbnailsRebuildResponse> {
      return post(ROUTES.system.indexerThumbnailsRebuild, IndexerThumbnailsRebuildResponse, {
        jsonBody: req ?? {},
      });
    },

    systemSearch(): Promise<SystemSearchResponse> {
      return get(ROUTES.system.search, SystemSearchResponse);
    },

    systemReembed(): Promise<SystemReembedResponse> {
      return post(ROUTES.system.searchReembed, SystemReembedResponse);
    },

    systemImageSearch(): Promise<SystemImageSearchResponse> {
      return get(ROUTES.system.imageSearch, SystemImageSearchResponse);
    },

    systemImageSearchRebuild(
      req?: IndexerThumbnailsRebuildRequest,
    ): Promise<IndexerThumbnailsRebuildResponse> {
      return post(ROUTES.system.imageSearchRebuild, IndexerThumbnailsRebuildResponse, {
        jsonBody: req ?? {},
      });
    },

    systemImageSearchClear(): Promise<IndexerClearResponse> {
      return post(ROUTES.system.imageSearchClear, IndexerClearResponse, { jsonBody: {} });
    },

    systemOcr(): Promise<SystemOcrResponse> {
      return get(ROUTES.system.ocr, SystemOcrResponse);
    },

    systemUpdateOcrSettings(settings: OcrSettingsUpdateRequest): Promise<OcrSettingsResponse> {
      return put(ROUTES.system.ocrSettings, OcrSettingsResponse, { jsonBody: settings });
    },

    systemRunOcr(): Promise<OcrRunResponse> {
      return post(ROUTES.system.ocrRun, OcrRunResponse);
    },

    systemThumbnails(): Promise<SystemThumbnailsResponse> {
      return get(ROUTES.system.thumbnails, SystemThumbnailsResponse);
    },

    systemRebuildThumbnails(): Promise<IndexerThumbnailsRebuildResponse> {
      return post(ROUTES.system.thumbnailsRebuild, IndexerThumbnailsRebuildResponse);
    },

    systemLogs(subsystem, query = {}) {
      return get(systemLogsRoute(subsystem), SystemLogsResponse, {
        query: {
          limit: query.limit === undefined ? undefined : String(query.limit),
          level: query.level,
          before: query.before,
        },
      });
    },

    officeStatus() {
      return get(ROUTES.office.status, OfficeStatusResponse);
    },
    officeOpen(req) {
      return post(ROUTES.office.open, OfficeOpenResponse, { jsonBody: req });
    },
    officeCreateDocument(req) {
      return post(ROUTES.office.documents, OfficeCreateDocumentResponse, { jsonBody: req });
    },
    listApiTokens(): Promise<ApiTokensResponse> {
      return get(ROUTES.account.tokens, ApiTokensResponse);
    },

    createApiToken(req: CreateApiTokenRequest): Promise<CreateApiTokenResponse> {
      return post(ROUTES.account.tokens, CreateApiTokenResponse, { jsonBody: req });
    },

    revokeApiToken(id: string): Promise<OkResponse> {
      return del(accountTokenRoute(id), OkResponse);
    },

    listTags(): Promise<TagsResponse> {
      return get(ROUTES.tags, TagsResponse);
    },

    createTag(req: CreateTagRequest): Promise<Tag> {
      return post(ROUTES.tags, Tag, { jsonBody: req });
    },

    updateTag(id: string, req: UpdateTagRequest): Promise<Tag> {
      return patch(tagRoute(id), Tag, { jsonBody: req });
    },

    deleteTag(id: string): Promise<OkResponse> {
      return del(tagRoute(id), OkResponse);
    },

    tagFiles(id: string): Promise<TagFilesResponse> {
      return get(tagFilesRoute(id), TagFilesResponse);
    },

    setFileTags(req: SetFileTagsRequest): Promise<OkResponse> {
      return put(ROUTES.fs.tags, OkResponse, { jsonBody: req });
    },

    listFavorites(): Promise<FavoritesResponse> {
      return get(ROUTES.favorites.base, FavoritesResponse);
    },

    addFavorite(req: FavoriteRequest): Promise<OkResponse> {
      return post(ROUTES.favorites.base, OkResponse, { jsonBody: req });
    },

    removeFavorite(req: FavoriteRequest): Promise<OkResponse> {
      return del(ROUTES.favorites.base, OkResponse, { jsonBody: req });
    },

    getFolderView(path: string): Promise<FolderViewResponse> {
      return get(ROUTES.folderViews.base, FolderViewResponse, { query: { path } });
    },

    setFolderView(req: SetFolderViewRequest): Promise<OkResponse> {
      return put(ROUTES.folderViews.base, OkResponse, { jsonBody: req });
    },

    removeFolderView(req: RemoveFolderViewRequest): Promise<OkResponse> {
      return del(ROUTES.folderViews.base, OkResponse, { jsonBody: req });
    },

    resetFolderViews(): Promise<OkResponse> {
      return del(ROUTES.folderViews.all, OkResponse);
    },

    listRecents(): Promise<RecentsResponse> {
      return get(ROUTES.recents.list, RecentsResponse);
    },

    touchRecent(req: RecentTouchRequest): Promise<OkResponse> {
      return post(ROUTES.recents.touch, OkResponse, { jsonBody: req });
    },

    trashStatus(): Promise<TrashStatusResponse> {
      return get(ROUTES.trash.status, TrashStatusResponse);
    },

    trashList(): Promise<TrashListResponse> {
      return get(ROUTES.trash.list, TrashListResponse);
    },

    trashRestore(req: TrashRestoreRequest): Promise<TrashRestoreResponse> {
      return post(ROUTES.trash.restore, TrashRestoreResponse, { jsonBody: req });
    },

    trashPurge(req: TrashPurgeRequest): Promise<OkResponse> {
      return post(ROUTES.trash.purge, OkResponse, { jsonBody: req });
    },

    trashEmpty(): Promise<OkResponse> {
      return post(ROUTES.trash.empty, OkResponse);
    },
  };
}
