import { isCoreError, isStorageError, StorageError, type StorageErrorKind } from "@fdrive/core";

/**
 * Node error codes by the storage kind they mean. Anything missing is
 * `internal`: an unexpected filesystem failure is a server fault, never the
 * caller's.
 */
const CODE_KINDS: Readonly<Record<string, StorageErrorKind>> = {
  ENOENT: "not_found",
  ENOTDIR: "not_found",
  EEXIST: "conflict",
  ENOTEMPTY: "conflict",
  EBUSY: "conflict",
  ERR_FS_CP_EEXIST: "conflict",
  ERR_FS_CP_DIR_TO_NON_DIR: "conflict",
  ERR_FS_CP_NON_DIR_TO_DIR: "conflict",
  EISDIR: "bad_request",
  EINVAL: "bad_request",
  ENAMETOOLONG: "bad_request",
  ELOOP: "bad_request",
  ERR_FS_CP_EINVAL: "bad_request",
  EACCES: "forbidden",
  EPERM: "forbidden",
  EROFS: "forbidden",
  ENOSPC: "payload_too_large",
  EDQUOT: "payload_too_large",
  EFBIG: "payload_too_large",
  EMFILE: "upstream_unavailable",
  ENFILE: "upstream_unavailable",
};

/** The `code` of a Node system error, or `undefined` for anything else. */
export function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** True for the errors an aborted signal produces, which pass through unmapped. */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Maps a filesystem failure on `path` (the caller's path, never the one on
 * disk, so the storage root does not leak into messages) to a
 * `StorageError`. Aborts and existing storage errors pass through.
 */
export function toStorageError(error: unknown, path: string): unknown {
  if (isStorageError(error) || isAbort(error)) return error;
  if (isCoreError(error)) {
    return new StorageError("bad_request", `invalid path: ${path}`, { cause: error });
  }
  const code = codeOf(error);
  const kind = (code !== undefined ? CODE_KINDS[code] : undefined) ?? "internal";
  return new StorageError(kind, `${kind.replaceAll("_", " ")}: ${path}`, {
    cause: error,
    ...(code === undefined ? {} : { details: { code } }),
  });
}

/** Runs `action`, rethrowing any failure as `toStorageError` maps it. */
export async function mapped<T>(path: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw toStorageError(error, path);
  }
}
