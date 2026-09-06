/**
 * The complete set of `/api/v1` route paths, as plain string literals, so
 * `apps/web` and `apps/api` can never drift on a path. HTTP methods are
 * documented per route below; they are not encoded in the type because a
 * single path (`fs.download`, `events`) can be reached with more than one
 * method or verb.
 */
export const ROUTES = {
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
  },
  search: {
    /** GET: hybrid search (semantic + full-text + filename) -> `SearchResponse`. 400 for an empty `q`. */
    query: "/api/v1/search",
    /** GET: whether search is configured, and whether semantic search is up -> `SearchStatusResponse`. */
    status: "/api/v1/search/status",
  },
  /** GET: stream a cached WebP thumbnail for a file. 404 when none exists. */
  thumb: "/api/v1/thumb",
  /** GET, Server-Sent Events: a stream of `SseEvent`s. */
  events: "/api/v1/events",
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
    /** GET, admin only: indexer health, stats, and settings -> `SystemIndexerResponse`. */
    indexer: "/api/v1/system/indexer",
    /** PUT, admin only: update the indexer's settings -> `IndexerSettingsResponse`. */
    indexerSettings: "/api/v1/system/indexer/settings",
    /** POST, admin only: mark files pending on the indexer -> `IndexerActionResponse`. */
    indexerReindex: "/api/v1/system/indexer/reindex",
    /** POST, admin only: mark thumbnails pending on the indexer -> `IndexerActionResponse`. */
    indexerThumbnailsRebuild: "/api/v1/system/indexer/thumbnails/rebuild",
    /** GET, admin only: semantic search and index totals -> `SystemSearchResponse`. */
    search: "/api/v1/system/search",
    /** POST, admin only: re-extract and re-embed every root -> `SystemReembedResponse`. */
    searchReembed: "/api/v1/system/search/reembed",
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

/**
 * Optional request header selecting which linked identity a request acts
 * as. When absent, the session's active identity is used.
 */
export const IDENTITY_HEADER = "x-identity-id";

/** Upload request header carrying the file's mtime, in ms since epoch. */
export const MODIFIED_AT_HEADER = "x-modified-at";
