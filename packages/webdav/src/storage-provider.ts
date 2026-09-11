import type { EntryStat, FileEntry, StorageProvider } from "@fdrive/core";
import {
  makeEntry,
  normalizePath,
  parentPath,
  StorageError,
  type StorageErrorKind,
} from "@fdrive/core";
import { WebdavError } from "./errors.js";
import type { WebdavClient, WebdavCredential, WebdavUserApi } from "./types.js";

export interface WebdavStorageProviderDeps {
  readonly client: WebdavClient;
  /**
   * The credential for each call. The API's session unseals it on demand;
   * the adapter never caches it, so a revoked or rotated password takes
   * effect on the next request.
   */
  readonly credential: () => Promise<WebdavCredential>;
}

/**
 * The options `download` actually accepts: `StorageProvider["download"]`'s
 * own `{ range?; signal? }` plus `ifRange` for a conditional range request.
 */
export interface WebdavDownloadOpts {
  range?: { start: number; end?: number };
  ifRange?: string;
  signal?: AbortSignal;
}

/** Status-specific overrides for one operation, where the protocol's meaning differs from the default table. */
type StatusKinds = Readonly<Record<number, StorageErrorKind>>;

/**
 * Maps a `WebdavErrorKind` to the `StorageErrorKind` a `StorageProvider`
 * caller expects. "network" and "server" (the server being unreachable,
 * failing, or redirecting) both become "upstream_unavailable"; a status the
 * protocol does not use ("unexpected") becomes "internal".
 */
function toStorageErrorKind(error: WebdavError, statusKinds: StatusKinds): StorageErrorKind {
  if (error.status !== null && statusKinds[error.status] !== undefined) {
    return statusKinds[error.status] as StorageErrorKind;
  }
  if (error.kind === "network" || error.kind === "server") return "upstream_unavailable";
  return error.kind === "unexpected" ? "internal" : error.kind;
}

/**
 * Converts a `WebdavError` into a `StorageError`, preserving its `detail`
 * (when present) as `details.detail` and its status as `details.status`.
 * Rethrows anything else unchanged, so callers only ever have to handle
 * `StorageError` for provider failures.
 */
export function toStorageError(error: unknown, statusKinds: StatusKinds = {}): never {
  if (!(error instanceof WebdavError)) throw error;
  const details: Record<string, unknown> = {};
  if (error.status !== null) details.status = error.status;
  if (error.detail !== null) details.detail = error.detail;
  throw new StorageError(toStorageErrorKind(error, statusKinds), error.message, {
    cause: error,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  });
}

/** A `MOVE`, `COPY` or bare `MKCOL` answering 409 is missing an intermediate collection. */
const MISSING_PARENT: StatusKinds = { 409: "not_found" };

async function run<T>(fn: () => Promise<T>, statusKinds?: StatusKinds): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    toStorageError(error, statusKinds);
  }
}

function toStat(stat: Awaited<ReturnType<WebdavUserApi["stat"]>>): EntryStat {
  return {
    kind: stat.kind,
    size: stat.size,
    modifiedAt: stat.modifiedAt,
    contentType: stat.contentType,
  };
}

async function statOrNull(api: WebdavUserApi, path: string): Promise<EntryStat | null> {
  try {
    return toStat(await api.stat(path));
  } catch (error) {
    if (error instanceof WebdavError && error.kind === "not_found") return null;
    throw error;
  }
}

/**
 * `mkdir -p`: creates `path` and every missing ancestor. An existing
 * collection is success; an existing file at any level is `conflict`.
 * Recurses upward only when `MKCOL` reports a missing parent, so an
 * ordinary create costs one request.
 */
async function ensureDir(api: WebdavUserApi, path: string): Promise<void> {
  if (path === "/") return;
  try {
    await api.mkcol(path);
    return;
  } catch (error) {
    if (!(error instanceof WebdavError) || error.kind !== "conflict") throw error;
  }
  const existing = await statOrNull(api, path);
  if (existing?.kind === "dir") return;
  if (existing !== null) {
    throw new StorageError("conflict", `a file exists at ${path}`);
  }
  await ensureDir(api, parentPath(path));
  await api.mkcol(path);
}

/**
 * Builds a `StorageProvider` over a WebDAV client. Every method normalizes
 * its path argument(s), binds the client to the session's current
 * credential, and converts a `WebdavError` into a `StorageError`. Returns
 * own-property methods so the API's Trash wrappers can spread the object.
 *
 * Overwrite behaviour: `move`, `copy` and `upload` overwrite an existing
 * target unless `overwrite: false`, which the protocol refuses with 412
 * (`conflict`). `mkdir` without `parents` refuses an existing path with
 * `conflict` and a missing parent with `not_found`.
 */
export function createWebdavStorageProvider(deps: WebdavStorageProviderDeps): StorageProvider {
  const api = async (): Promise<WebdavUserApi> => deps.client.user(await deps.credential());

  async function stat(path: string): Promise<EntryStat> {
    return run(async () => toStat(await (await api()).stat(path)));
  }

  return {
    async list(path: string): Promise<FileEntry[]> {
      const normalized = normalizePath(path);
      const entries = await run(async () => (await api()).list(normalized));
      return entries.map((entry) =>
        makeEntry(normalized, {
          name: entry.name,
          kind: entry.kind,
          size: entry.size,
          modifiedAt: entry.modifiedAt ?? new Date(0),
        }),
      );
    },

    stat: (path) => stat(normalizePath(path)),

    async statFile(path: string) {
      const result = await stat(normalizePath(path));
      if (result.kind === "dir") {
        throw new StorageError("bad_request", `not a file: ${normalizePath(path)}`);
      }
      return { size: result.size, modifiedAt: result.modifiedAt, contentType: result.contentType };
    },

    probeDirectoryRead: (path) =>
      run(async () => (await api()).probeDirectoryRead(normalizePath(path))),

    download: (path, opts) =>
      run(async () => (await api()).download(normalizePath(path), opts ?? {})),

    async upload(path, body, opts) {
      const normalized = normalizePath(path);
      const user = await api();
      await run(async () => {
        if (opts?.mkdirParents === true) await ensureDir(user, parentPath(normalized));
        await user.upload(normalized, body, {
          ...(opts?.contentLength === undefined ? {} : { contentLength: opts.contentLength }),
          ...(opts?.modifiedAt === undefined ? {} : { modifiedAt: opts.modifiedAt }),
          ...(opts?.overwrite === undefined ? {} : { overwrite: opts.overwrite }),
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        });
      });
    },

    async mkdir(path, opts) {
      const normalized = normalizePath(path);
      const user = await api();
      if (opts?.parents === true) return run(() => ensureDir(user, normalized));
      return run(() => user.mkcol(normalized), MISSING_PARENT);
    },

    move: (path, target, opts) =>
      run(
        async () => (await api()).move(normalizePath(path), normalizePath(target), opts ?? {}),
        MISSING_PARENT,
      ),

    copy: (path, target, opts) =>
      run(
        async () => (await api()).copy(normalizePath(path), normalizePath(target), opts ?? {}),
        MISSING_PARENT,
      ),

    async deleteFile(path: string) {
      const normalized = normalizePath(path);
      const existing = await stat(normalized);
      if (existing.kind === "dir") {
        throw new StorageError("bad_request", `not a file: ${normalized}`);
      }
      await run(async () => (await api()).delete(normalized));
    },

    async deleteDir(path: string) {
      const normalized = normalizePath(path);
      const existing = await stat(normalized);
      if (existing.kind !== "dir") {
        throw new StorageError("bad_request", `not a directory: ${normalized}`);
      }
      await run(async () => (await api()).delete(normalized));
    },
  };
}
