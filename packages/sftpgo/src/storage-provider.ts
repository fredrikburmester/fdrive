import type { EntryStat, FileEntry, StorageProvider } from "@fdrive/core";
import {
  baseName,
  isStorageError,
  makeEntry,
  normalizePath,
  parentPath,
  StorageError,
  type StorageErrorKind,
} from "@fdrive/core";
import { SftpgoError } from "./errors.js";
import type { SftpgoClient } from "./types.js";

/**
 * Retries the wrapped call once on a 401 from SFTPGo (by re-minting a
 * token) and returns the eventual result. Provided by the auth chunk; this
 * module only depends on the shape.
 */
export type WithToken = <T>(fn: (token: string) => Promise<T>) => Promise<T>;

export interface SftpgoStorageProviderDeps {
  readonly client: SftpgoClient;
  readonly withToken: WithToken;
}

/**
 * The options `download` actually accepts: a superset of
 * `StorageProvider["download"]`'s own `{ range?; signal? }`, adding
 * `ifRange` for a conditional range request. Callers that only see the
 * `StorageProvider` interface can still pass `ifRange` through by building
 * their options object with this type (or any type that mentions `range`
 * or `signal`) rather than as an inline object literal, since TypeScript's
 * excess-property check only applies to fresh literals.
 */
export interface SftpgoDownloadOpts {
  range?: { start: number; end?: number };
  ifRange?: string;
  signal?: AbortSignal;
}

/**
 * Maps a `SftpgoErrorKind` to the `StorageErrorKind` a `StorageProvider`
 * caller expects. "network" and "server" (SFTPGo itself being unreachable
 * or failing) both become "upstream_unavailable"; any status SFTPGo does
 * not use ("unexpected") becomes "internal".
 */
function toStorageErrorKind(error: SftpgoError): StorageErrorKind {
  if (error.kind === "network" || error.kind === "server") return "upstream_unavailable";
  return error.kind === "unexpected" ? "internal" : error.kind;
}

/**
 * Converts a `SftpgoError` into a `StorageError`, preserving its `detail`
 * string (when present) as `details.detail`. Rethrows anything else
 * unchanged, so callers only ever have to handle `StorageError` for
 * provider failures.
 */
export function toStorageError(error: unknown): never {
  if (!(error instanceof SftpgoError)) {
    throw error;
  }
  throw new StorageError(toStorageErrorKind(error), error.message, {
    cause: error,
    ...(error.detail !== null ? { details: { detail: error.detail } } : {}),
  });
}

async function runStorage<T>(withToken: WithToken, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await withToken(fn);
  } catch (error) {
    toStorageError(error);
  }
}

/**
 * Builds a `StorageProvider` backed by a SFTPGo user API client. Every
 * method normalizes its path argument(s) with `normalizePath`, performs
 * the SFTPGo call inside `withToken`, and converts a `SftpgoError` into a
 * `StorageError` on failure.
 */
export function createSftpgoStorageProvider(deps: SftpgoStorageProviderDeps): StorageProvider {
  const { client, withToken } = deps;
  const runUser = <T>(fn: (user: ReturnType<SftpgoClient["user"]>) => Promise<T>) =>
    runStorage(withToken, (token) => fn(client.user(token)));

  return {
    async list(path: string): Promise<FileEntry[]> {
      const normalized = normalizePath(path);
      const entries = await runUser((u) => u.list(normalized));
      return entries.map((entry) => makeEntry(normalized, entry));
    },

    probeDirectoryRead: (path) => runUser((u) => u.probeDirectoryRead(normalizePath(path))),
    statFile: (path) => runUser((u) => u.statFile(normalizePath(path))),

    async stat(path: string): Promise<EntryStat> {
      const normalized = normalizePath(path);
      try {
        const file = await runUser((u) => u.statFile(normalized));
        return { kind: "file", ...file };
      } catch (error) {
        if (!isStorageError(error) || error.kind !== "bad_request") throw error;
      }
      if (normalized === "/") {
        return { kind: "dir", size: 0, modifiedAt: null, contentType: null };
      }
      const entries = await runUser((u) => u.list(parentPath(normalized)));
      const match = entries.find((entry) => entry.name === baseName(normalized));
      if (!match) throw new StorageError("not_found", `not found: ${normalized}`);
      return {
        kind: match.kind,
        size: match.size,
        modifiedAt: match.modifiedAt,
        contentType: null,
      };
    },

    download: (path, opts) => runUser((u) => u.download(normalizePath(path), opts ?? {})),
    upload: (path, body, opts) => runUser((u) => u.upload(normalizePath(path), body, opts ?? {})),
    mkdir: (path, opts) => runUser((u) => u.mkdir(normalizePath(path), opts ?? {})),
    move: (path, target) => runUser((u) => u.move(normalizePath(path), normalizePath(target))),
    copy: (path, target) => runUser((u) => u.copy(normalizePath(path), normalizePath(target))),
    deleteFile: (path) => runUser((u) => u.deleteFile(normalizePath(path))),
    deleteDir: (path) => runUser((u) => u.deleteDir(normalizePath(path))),
    setModifiedAt: (path, at) => runUser((u) => u.setModifiedAt(normalizePath(path), at)),
    zip: (paths, opts) =>
      runUser((u) =>
        u.zip(
          paths.map((p) => normalizePath(p)),
          opts ?? {},
        ),
      ),
  };
}
