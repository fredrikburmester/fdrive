/**
 * The complete set of `/api/v1` route paths, as plain string literals, so
 * `apps/web` and `apps/api` can never drift on a path. HTTP methods are
 * documented per route below; they are not encoded in the type because a
 * single path (`fs.download`, `events`) can be reached with more than one
 * method or verb.
 */
export const ROUTES = {
  /** GET, public: API liveness and subsystem status -> `HealthResponse`. */
  health: "/api/v1/health",
  shares: "/api/v1/shares",
  publicShares: "/api/v1/public/shares",
  office: {
    status: "/api/v1/office",
    open: "/api/v1/office/open",
    documents: "/api/v1/office/documents",
  },
  auth: {
    /** POST: username + password (+ otp) -> `LoginResponse`. */
    login: "/api/v1/auth/login",
    /** POST: end the current session. */
    logout: "/api/v1/auth/logout",
    /** GET: the signed-in account and its identities -> `MeResponse`. */
    me: "/api/v1/auth/me",
  },
  fs: {
    /** GET: list a directory -> `ListResponse`. */
    list: "/api/v1/fs/list",
    /** GET: stat a path -> `EntryResponse`. */
    stat: "/api/v1/fs/stat",
    /** GET or HEAD: stream (or probe) file contents. */
    download: "/api/v1/fs/download",
    /** POST: stream a zip of the given paths. */
    zip: "/api/v1/fs/zip",
    /** PUT: stream a file's contents to `path`. */
    upload: "/api/v1/fs/upload",
    /** POST: create a directory. */
    mkdir: "/api/v1/fs/mkdir",
    /** POST: move a path. */
    move: "/api/v1/fs/move",
    /** POST: move several paths, continuing past failures -> `MoveManyResponse`. */
    moveMany: "/api/v1/fs/move-many",
    /** POST: copy a path. */
    copy: "/api/v1/fs/copy",
    /** POST: rename a path in place. */
    rename: "/api/v1/fs/rename",
    /** POST: delete one or more paths. */
    delete: "/api/v1/fs/delete",
    /** POST: copy a path next to itself with a unique name -> `EntryResponse`. */
    duplicate: "/api/v1/fs/duplicate",
    /** POST: build an archive from a selection as a job -> `JobAccepted` (202). */
    compress: "/api/v1/fs/compress",
    /** POST: extract an archive as a job -> `JobAccepted` (202). */
    extract: "/api/v1/fs/extract",
    /** GET: the caller's jobs -> `JobsResponse`. */
    jobs: "/api/v1/fs/jobs",
    /** GET: an archive's entries, without extracting it -> `ArchiveEntriesResponse`. */
    archiveEntries: "/api/v1/fs/archive-entries",
    /** GET: a directory's total size, from the index only -> `FolderSizeResponse`. */
    folderSize: "/api/v1/fs/folder-size",
    /** PUT: replace the full set of tags on a path -> `OkResponse`. */
    tags: "/api/v1/fs/tags",
  },
  /**
   * GET: the caller's tags -> `TagsResponse`.
   * POST: create a tag -> `Tag`. 409 on a duplicate name.
   * `:id` PATCH: update a tag -> `Tag`. 404 for a tag owned by another account.
   * `:id` DELETE: delete a tag -> `OkResponse`. A no-op (200) when already gone.
   * `:id/files` GET: every path (for the caller's active identity) with that tag -> `TagFilesResponse`.
   */
  tags: "/api/v1/tags",
  favorites: {
    /**
     * Active-identity scoped favorites CRUD:
     * GET: the caller's active identity favorites -> `FavoritesResponse`.
     * POST: favorite a path -> `OkResponse`.
     * DELETE: unfavorite a path (body `{ path }`) -> `OkResponse`.
     * For account-wide aggregated favorites, see `account.favorites`.
     */
    base: "/api/v1/favorites",
  },
  folderViews: {
    /** GET one folder pin (`?path=`), PUT a mode, DELETE one pin (`{ path }`). */
    base: "/api/v1/folder-views",
    /** DELETE: reset every folder pin across the caller's linked identities. */
    all: "/api/v1/folder-views/all",
  },
  recents: {
    /** GET: the caller's recently opened paths -> `RecentsResponse`. */
    list: "/api/v1/recents",
    /** POST: record a path as opened now -> `OkResponse`. */
    touch: "/api/v1/recents/touch",
  },
  search: {
    /** GET: hybrid search (semantic + full-text + filename) -> `SearchResponse`. 400 for an empty `q`. */
    query: "/api/v1/search",
    /** GET: whether search is configured, and whether semantic/image search is up -> `SearchStatusResponse`. */
    status: "/api/v1/search/status",
    /** GET: image-content search over embedded thumbnails -> `ImageSearchResponse`. 400 for an empty `q`. */
    images: "/api/v1/search/images",
  },
  /** GET: stream a cached WebP thumbnail for a file. 404 when none exists. */
  thumb: "/api/v1/thumb",
  /** GET, Server-Sent Events: a stream of `SseEvent`s. */
  events: "/api/v1/events",
  trash: {
    /** GET: whether the active identity's storage exposes a trash -> `TrashStatusResponse`. */
    status: "/api/v1/trash/status",
    /** GET: the trash's entries -> `TrashListResponse`. 404 when no trash is configured. */
    list: "/api/v1/trash",
    /** POST: restore one or more entries -> `TrashRestoreResponse`. */
    restore: "/api/v1/trash/restore",
    /** POST: permanently delete one or more entries -> `OkResponse`. */
    purge: "/api/v1/trash/purge",
    /** POST: permanently delete every entry -> `OkResponse`. */
    empty: "/api/v1/trash/empty",
  },
  activity: {
    /** GET: the caller's own history -> `PersonalActivityResponse`. Account session only. */
    feed: "/api/v1/activity",
    /** POST: report one gesture only the browser can see -> `{ id }` (202). */
    clientEvents: "/api/v1/activity/client-events",
    /** GET: the storages the caller has history on -> `ActivityLocationsResponse`. */
    locations: "/api/v1/activity/locations",
    /** GET: the history ID for one `identityId` and `path` -> `{ id }`. 404 before anything is recorded. */
    resolveFile: "/api/v1/activity/files/resolve",
    /** GET: one file's journey -> `ActivityFileResponse`. `/:id/events`, `/:id/lineage`, `/:id/revisions` and `POST /:id/recheck` hang off it. */
    files: "/api/v1/activity/files",
    /** GET: `/:id/events` for one batch -> `PersonalActivityResponse` with a `batchSummary`. */
    batches: "/api/v1/activity/batches",
    /** GET: one immutable event -> `PersonalActivityEvent`. `/:id/subjects` pages its full membership. */
    events: "/api/v1/activity/events",
    /** GET, Server-Sent Events: committed history sequences for the caller. */
    stream: "/api/v1/activity/stream",
    /** POST: pin a snapshot of the caller's own history -> `{ id }`. `/:id` and `/:id/download` read it back. */
    exports: "/api/v1/activity/exports",
  },
  ai: {
    /** GET: whether AI actions are available to the caller -> `AiStatusResponse`. */
    status: "/api/v1/ai/status",
    /** POST: ask the assistant where selected items belong -> `OrganizeRun` (202). Nothing moves. */
    organize: "/api/v1/ai/organize",
    /** GET: the caller's recent chats -> `ChatListResponse`. POST: start a chat -> `Chat` (201). */
    chats: "/api/v1/ai/chats",
  },
  /** GET: version and configured providers -> `AboutResponse`. */
  about: "/api/v1/about",
  /** GET, public: the enabled providers and their credential forms -> `ProvidersResponse`. */
  providers: "/api/v1/providers",
  setup: {
    /** GET, public: whether setup is required -> `SetupStatusResponse`. */
    status: "/api/v1/setup/status",
    /** POST, setup token required: probe a candidate SFTPGo -> `ConnectionTestResponse`. */
    test: "/api/v1/setup/test",
    /** POST, setup token required: store the connection, create the admin account -> `MeResponse`. */
    complete: "/api/v1/setup/complete",
  },
  admin: {
    /** GET, admin only: every configured provider -> `AdminProvidersResponse`; POST: add one -> `AdminProvider`. */
    providers: "/api/v1/admin/providers",
    /** POST, admin only: probe an unsaved candidate -> `ConnectionTestResponse`. */
    providersTest: "/api/v1/admin/providers/test",
  },
  system: {
    activity: "/api/v1/system/activity",
    features: "/api/v1/system/features",
    /** GET/PUT, admin only: the address everyone opens fdrive at -> `PublicUrlSettings`. */
    publicUrl: "/api/v1/system/public-url",
    /** GET/PUT, admin only: Office activation and editing permission. */
    office: "/api/v1/system/office",
    /** GET/PUT, admin only: the AI provider, model and key -> `SystemAiResponse`. */
    ai: "/api/v1/system/ai",
    /** POST, admin only: send one short request with the saved AI settings -> `AiConnectionTestResponse`. */
    aiTest: "/api/v1/system/ai/test",
    /** GET/PUT, admin only: provider-bound Trash configuration. */
    trash: "/api/v1/system/trash",
    /** GET/PUT, admin only: folder-level virtual folder mappings -> `MountMappingsResponse`. */
    mountMappings: "/api/v1/system/mount-mappings",
    /** GET, admin only: indexer health, stats, and settings -> `SystemIndexerResponse`. */
    indexer: "/api/v1/system/indexer",
    /** PUT, admin only: update the indexer's settings -> `IndexerSettingsResponse`. */
    indexerSettings: "/api/v1/system/indexer/settings",
    /** POST, admin only: mark files pending on the indexer -> `IndexerActionResponse`. */
    indexerReindex: "/api/v1/system/indexer/reindex",
    indexerClear: "/api/v1/system/indexer/clear",
    /** POST, admin only: start a thumbnail rebuild -> `IndexerThumbnailsRebuildResponse` (202). */
    indexerThumbnailsRebuild: "/api/v1/system/indexer/thumbnails/rebuild",
    /** GET, admin only: semantic search and index totals -> `SystemSearchResponse`. */
    search: "/api/v1/system/search",
    /** POST, admin only: re-extract and re-embed every root -> `SystemReembedResponse`. */
    searchReembed: "/api/v1/system/search/reembed",
    /** GET, admin only: image search health, config, and index totals -> `SystemImageSearchResponse`. */
    imageSearch: "/api/v1/system/image-search",
    /** POST, admin only: backfill/rebuild image-content embeddings -> `IndexerThumbnailsRebuildResponse`. */
    imageSearchRebuild: "/api/v1/system/image-search/rebuild",
    /** POST, admin only: delete every image-content embedding -> `IndexerClearResponse`. */
    imageSearchClear: "/api/v1/system/image-search/clear",
    /** GET, admin only: OCR schedule, last run, and settings -> `SystemOcrResponse`. */
    ocr: "/api/v1/system/ocr",
    /** PUT, admin only: update the OCR service's settings -> `OcrSettingsResponse`. */
    ocrSettings: "/api/v1/system/ocr/settings",
    /** POST, admin only: run the OCR pass now -> `OcrRunResponse`. */
    ocrRun: "/api/v1/system/ocr/run",
    /** GET, admin only: originals kept before an OCR rewrite -> `OcrOriginalsResponse`. */
    ocrOriginals: "/api/v1/system/ocr/originals",
    /** GET, admin only: stream one kept original's bytes. */
    ocrOriginalDownload: "/api/v1/system/ocr/originals/download",
    /** POST, admin only: put one kept original back -> `OcrOriginalRestoreResponse`. */
    ocrOriginalRestore: "/api/v1/system/ocr/originals/restore",
    /** POST, admin only: delete one kept original -> `OcrOriginalDeleteResponse`. */
    ocrOriginalDelete: "/api/v1/system/ocr/originals/delete",
    /** GET, admin only: thumbnail cache size -> `SystemThumbnailsResponse`. */
    thumbnails: "/api/v1/system/thumbnails",
    /** POST, admin only: rebuild every missing thumbnail -> `IndexerThumbnailsRebuildResponse` (202). */
    thumbnailsRebuild: "/api/v1/system/thumbnails/rebuild",
    thumbnailsClear: "/api/v1/system/thumbnails/clear",
  },
  account: {
    identities: "/api/v1/account/identities",
    activeIdentity: "/api/v1/account/active-identity",
    /** GET: aggregated favorites across all identities linked to the account -> `AccountFavoritesResponse`. */
    favorites: "/api/v1/account/favorites",
    search: "/api/v1/account/search",
    /**
     * GET: the caller's API tokens (never their secrets) -> `ApiTokensResponse`.
     * POST: create a token, shown once -> `CreateApiTokenResponse`.
     * DELETE `/:id`: revoke a token.
     * Session-authenticated only; never reachable with a bearer token.
     */
    tokens: "/api/v1/account/tokens",
  },
} as const;

export type Routes = typeof ROUTES;

/** `PATCH`/`DELETE`, admin only: one configured provider. */
export function adminProviderRoute(id: string): string {
  return `${ROUTES.admin.providers}/${encodeURIComponent(id)}`;
}

/** `POST`, admin only: probe one configured provider -> `ConnectionTestResponse`. */
export function adminProviderTestRoute(id: string): string {
  return `${adminProviderRoute(id)}/test`;
}

/** GET: one job -> `JobStatus`. 404 for a job that belongs to another identity. */
export function jobRoute(id: string): string {
  return `${ROUTES.fs.jobs}/${encodeURIComponent(id)}`;
}

/** GET: one organize run -> `OrganizeRun`. 404 for a run that belongs to another identity. */
export function organizeRunRoute(id: string): string {
  return `${ROUTES.ai.organize}/${encodeURIComponent(id)}`;
}

/** POST: stop an organize run -> `OrganizeRun`. 404 for a run that belongs to another identity. */
export function organizeRunCancelRoute(id: string): string {
  return `${organizeRunRoute(id)}/cancel`;
}

/** GET: one chat with its transcript -> `Chat`. PATCH: rename -> `Chat`. DELETE: remove it -> `OkResponse`. 404 for another identity's chat. */
export function chatRoute(id: string): string {
  return `${ROUTES.ai.chats}/${encodeURIComponent(id)}`;
}

/** POST: send a message -> `Chat` (202); the reply arrives while the chat is `running`. */
export function chatMessagesRoute(id: string): string {
  return `${chatRoute(id)}/messages`;
}

/** POST: stop the reply being written -> `Chat`. */
export function chatCancelRoute(id: string): string {
  return `${chatRoute(id)}/cancel`;
}

/** POST: apply or decline one pending action card -> `Chat` (202 while the assistant continues). */
export function chatActionRoute(id: string, actionId: string): string {
  return `${chatRoute(id)}/actions/${encodeURIComponent(actionId)}`;
}

/** GET, admin only: one subsystem's event log -> `SystemLogsResponse`. */
export function systemLogsRoute(subsystem: string): string {
  return `/api/v1/system/${encodeURIComponent(subsystem)}/logs`;
}

/** POST: cancel a job -> `JobStatus`. 404 for a job that belongs to another identity. */
export function jobCancelRoute(id: string): string {
  return `${jobRoute(id)}/cancel`;
}

/** DELETE: revoke one API token -> `OkResponse`. 404 for a token that belongs to another account. */
export function accountTokenRoute(id: string): string {
  return `${ROUTES.account.tokens}/${encodeURIComponent(id)}`;
}

/** PATCH/DELETE: one tag by id -> `Tag` / `OkResponse`. */
export function tagRoute(id: string): string {
  return `${ROUTES.tags}/${encodeURIComponent(id)}`;
}

/** GET: every path tagged with `id` -> `TagFilesResponse`. */
export function tagFilesRoute(id: string): string {
  return `${tagRoute(id)}/files`;
}

/**
 * Optional request header selecting which linked identity a request acts
 * as. When absent, the session's active identity is used.
 */
export const IDENTITY_HEADER = "x-identity-id";

/** Upload request header carrying the file's mtime, in ms since epoch. */
export const MODIFIED_AT_HEADER = "x-modified-at";

export function shareRoute(id: string): string {
  return `${ROUTES.shares}/${encodeURIComponent(id)}`;
}
/** Named public-share subroutes used by both clients. IDs are encoded once. */
export const PUBLIC_SHARE_SUFFIXES = {
  metadata: "",
  credentials: "/credentials",
  entries: "/entries",
  archiveEntries: "/archive-entries",
  download: "/download",
  archive: "/archive",
  thumb: "/thumb",
  upload: "/upload",
} as const;

export function publicShareRoute(
  id: string,
  action: keyof typeof PUBLIC_SHARE_SUFFIXES = "metadata",
): string {
  return `${ROUTES.publicShares}/${encodeURIComponent(id)}${PUBLIC_SHARE_SUFFIXES[action]}`;
}

/**
 * GET: an identity's scope mapping and index-availability status ->
 * `IdentityScopeResponse`. PUT (admin + CSRF, owned identity): replace the
 * identity's scope override -> `IdentityScopeResponse`; `{ scopes: [] }`
 * resets it to the template-derived home scope.
 */
export function identityScopeRoute(id: string): string {
  return `${ROUTES.account.identities}/${encodeURIComponent(id)}/scope`;
}

/** GET, admin only: candidate physical locations for the identity's unmapped mounts -> `IdentityScopeSuggestionsResponse`. */
export function identityScopeSuggestionsRoute(id: string): string {
  return `${identityScopeRoute(id)}/suggestions`;
}

/** GET/HEAD identity selection for URLs that cannot send headers (images/downloads).
 * This selects an owned identity within the authenticated session; it is not a credential.
 * Repeated values and disagreement with IDENTITY_HEADER are rejected. */
export const IDENTITY_QUERY_PARAM = "identity";
