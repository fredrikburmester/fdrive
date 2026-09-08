import type { FileEntry, StorageProvider } from "@fdrive/core";
import { makeEntry, normalizePath, StorageError, type StorageErrorKind } from "@fdrive/core";
import { type SftpgoClient, SftpgoError } from "@fdrive/sftpgo";

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
  switch (error.kind) {
    case "unauthorized":
      return "unauthorized";
    case "forbidden":
      return "forbidden";
    case "not_found":
      return "not_found";
    case "conflict":
      return "conflict";
    case "payload_too_large":
      return "payload_too_large";
    case "rate_limited":
      return "rate_limited";
    case "bad_request":
      return "bad_request";
    case "network":
    case "server":
      return "upstream_unavailable";
    case "unexpected":
      return "internal";
  }
}

/**
 * Converts a `SftpgoError` into a `StorageError`, preserving its `detail`
 * string (when present) as `details.detail`. Rethrows anything else
 * unchanged, so callers only ever have to handle `StorageError` for
 * provider failures.
 */
function toStorageError(error: unknown): never {
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

  return {
    async list(path: string): Promise<FileEntry[]> {
      const normalized = normalizePath(path);
      const entries = await runStorage(withToken, (token) => client.user(token).list(normalized));
      return entries.map((entry) =>
        makeEntry(normalized, {
          name: entry.name,
          kind: entry.kind,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
        }),
      );
    },

    async probeDirectoryRead(path: string): Promise<void> {
      const normalized = normalizePath(path);
      await runStorage(withToken, (token) => client.user(token).probeDirectoryRead(normalized));
    },

    async statFile(path: string) {
      const normalized = normalizePath(path);
      return runStorage(withToken, (token) => client.user(token).statFile(normalized));
    },

    async download(path: string, opts?: SftpgoDownloadOpts) {
      const normalized = normalizePath(path);
      return runStorage(withToken, (token) =>
        client.user(token).download(normalized, {
          ...(opts?.range !== undefined ? { range: opts.range } : {}),
          ...(opts?.ifRange !== undefined ? { ifRange: opts.ifRange } : {}),
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        }),
      );
    },

    async upload(
      path: string,
      body: ReadableStream<Uint8Array> | Uint8Array,
      opts?: {
        mkdirParents?: boolean;
        modifiedAt?: Date;
        contentLength?: number;
        signal?: AbortSignal;
      },
    ): Promise<void> {
      const normalized = normalizePath(path);
      await runStorage(withToken, (token) =>
        client.user(token).upload(normalized, body, {
          ...(opts?.mkdirParents !== undefined ? { mkdirParents: opts.mkdirParents } : {}),
          ...(opts?.modifiedAt !== undefined ? { modifiedAt: opts.modifiedAt } : {}),
          ...(opts?.contentLength !== undefined ? { contentLength: opts.contentLength } : {}),
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        }),
      );
    },

    async mkdir(path: string, opts?: { parents?: boolean }): Promise<void> {
      const normalized = normalizePath(path);
      await runStorage(withToken, (token) =>
        client.user(token).mkdir(normalized, {
          ...(opts?.parents !== undefined ? { parents: opts.parents } : {}),
        }),
      );
    },

    async move(path: string, target: string): Promise<void> {
      const normalizedPath = normalizePath(path);
      const normalizedTarget = normalizePath(target);
      await runStorage(withToken, (token) =>
        client.user(token).move(normalizedPath, normalizedTarget),
      );
    },

    async copy(path: string, target: string): Promise<void> {
      const normalizedPath = normalizePath(path);
      const normalizedTarget = normalizePath(target);
      await runStorage(withToken, (token) =>
        client.user(token).copy(normalizedPath, normalizedTarget),
      );
    },

    async deleteFile(path: string): Promise<void> {
      const normalized = normalizePath(path);
      await runStorage(withToken, (token) => client.user(token).deleteFile(normalized));
    },

    async deleteDir(path: string): Promise<void> {
      const normalized = normalizePath(path);
      await runStorage(withToken, (token) => client.user(token).deleteDir(normalized));
    },

    async setModifiedAt(path: string, modifiedAt: Date): Promise<void> {
      const normalized = normalizePath(path);
      await runStorage(withToken, (token) =>
        client.user(token).setModifiedAt(normalized, modifiedAt),
      );
    },

    async zip(paths: readonly string[]): Promise<ReadableStream<Uint8Array>> {
      const normalized = paths.map((path) => normalizePath(path));
      return runStorage(withToken, (token) => client.user(token).zip(normalized));
    },
  };
}
