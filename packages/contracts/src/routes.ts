/**
 * The complete set of `/api/v1` route paths, as plain string literals, so
 * `apps/web` and `apps/api` can never drift on a path. HTTP methods are
 * documented per route below; they are not encoded in the type because a
 * single path (`fs.download`, `events`) can be reached with more than one
 * method or verb.
 */
export const ROUTES = {
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
     * GET: the caller's favorites -> `FavoritesResponse`.
     * POST: favorite a path -> `OkResponse`.
     * DELETE: unfavorite a path (body `{ path }`) -> `OkResponse`.
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
  /** GET: version and SFTPGo attribution -> `AboutResponse`. */
  about: "/api/v1/about",
  setup: {
    /** GET, public: whether setup is required -> `SetupStatusResponse`. */
    status: "/api/v1/setup/status",
    /** POST, setup token required: probe a candidate SFTPGo -> `ConnectionTestResponse`. */
    test: "/api/v1/setup/test",
    /** POST, setup token required: store the connection, create the admin account -> `MeResponse`. */
    complete: "/api/v1/setup/complete",
  },
  admin: {
    /** GET, admin only: the active connection -> `AdminConnectionResponse`. */
    connection: "/api/v1/admin/connection",
    /** PUT, admin only: update the connection -> `AdminConnectionResponse`. */
    connectionUpdate: "/api/v1/admin/connection",
    /** POST, admin only: probe the active or a candidate connection -> `ConnectionTestResponse`. */
    connectionTest: "/api/v1/admin/connection/test",
  },
  system: {
    features: "/api/v1/system/features",
    /** GET/PUT, admin only: provider-bound Trash configuration. */
    trash: "/api/v1/system/trash",
    /** GET, admin only: indexer health, stats, and settings -> `SystemIndexerResponse`. */
    indexer: "/api/v1/system/indexer",
    /** PUT, admin only: update the indexer's settings -> `IndexerSettingsResponse`. */
    indexerSettings: "/api/v1/system/indexer/settings",
    /** POST, admin only: mark files pending on the indexer -> `IndexerActionResponse`. */
    indexerReindex: "/api/v1/system/indexer/reindex",
    indexerClear: "/api/v1/system/indexer/clear",
    /** POST, admin only: mark thumbnails pending on the indexer -> `IndexerActionResponse`. */
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
    /** GET, admin only: thumbnail cache size -> `SystemThumbnailsResponse`. */
    thumbnails: "/api/v1/system/thumbnails",
    /** POST, admin only: rebuild every missing thumbnail -> `IndexerActionResponse`. */
    thumbnailsRebuild: "/api/v1/system/thumbnails/rebuild",
    thumbnailsClear: "/api/v1/system/thumbnails/clear",
  },
  account: {
    identities: "/api/v1/account/identities",
    activeIdentity: "/api/v1/account/active-identity",
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

/** GET: one job -> `JobStatus`. 404 for a job that belongs to another identity. */
export function jobRoute(id: string): string {
  return `${ROUTES.fs.jobs}/${encodeURIComponent(id)}`;
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
export function publicShareRoute(id: string): string {
  return `${ROUTES.publicShares}/${encodeURIComponent(id)}`;
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
