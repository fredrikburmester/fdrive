import { z } from "zod";
import { ApiError } from "./error.ts";
import { ArchiveFormat } from "./jobs.ts";

/**
 * The kind of filesystem entry, mirroring `@fdrive/core`'s `EntryKind` and
 * SFTPGo's own mode bits (`dir`, `symlink`, `file`, `other` for anything
 * that is none of those).
 */
export const EntryKind = z.enum(["file", "dir", "symlink", "other"]);

export type EntryKind = z.infer<typeof EntryKind>;

/** Tag and favorite metadata attached to an `FsEntry`, when the caller's identity has any. */
export const FsEntryMeta = z.object({
  tagIds: z.array(z.string()),
  favorite: z.boolean(),
});

export type FsEntryMeta = z.infer<typeof FsEntryMeta>;

/**
 * One entry as returned to the browser: normalized kind, size, an ISO
 * `modifiedAt`, and a best-effort `mime` guess (`null` when unknown, always
 * `null` for directories). `meta` is present when the response was decorated
 * with tag and favorite data (currently only `GET /fs/list`); absent
 * elsewhere.
 */
export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: EntryKind,
  size: z.number().int().min(0),
  modifiedAt: z.iso.datetime(),
  ext: z.string(),
  mime: z.string().nullable(),
  meta: FsEntryMeta.optional(),
  /** A write committed but its follow-up stat failed. Size/time are placeholders until refresh. */
  metadataPending: z.boolean().optional(),
});

export type FsEntry = z.infer<typeof FsEntry>;

export const ListResponse = z.object({
  path: z.string(),
  entries: z.array(FsEntry),
});

export type ListResponse = z.infer<typeof ListResponse>;

export const PathQuery = z.object({
  path: z.string(),
});

export type PathQuery = z.infer<typeof PathQuery>;

/**
 * A directory's total size as computed from the index alone: `bytes` and
 * `files` sum every indexed file under `path` (intersected with the
 * caller's verified index scope), and `indexed` is `false` whenever that
 * total is unavailable (the folder is out of scope, not covered by any
 * indexed root, or the caller cannot currently read it), in which case
 * `bytes` and `files` are both `0`.
 */
export const FolderSizeResponse = z.object({
  path: z.string(),
  bytes: z.number().int().min(0),
  files: z.number().int().min(0),
  indexed: z.boolean(),
});

export type FolderSizeResponse = z.infer<typeof FolderSizeResponse>;

export const DownloadQuery = z.object({
  path: z.string(),
  inline: z.literal("1").optional(),
});

export type DownloadQuery = z.infer<typeof DownloadQuery>;

export const UploadQuery = z.object({
  intent: z.enum(["upload", "create", "save"]).optional(),
  path: z.string(),
  mkdirParents: z.enum(["true", "false"]).optional(),
});

export type UploadQuery = z.infer<typeof UploadQuery>;

export const MkdirRequest = z.object({
  path: z.string(),
});

export type MkdirRequest = z.infer<typeof MkdirRequest>;

export const MoveRequest = z.object({
  path: z.string(),
  target: z.string(),
});

export type MoveRequest = z.infer<typeof MoveRequest>;

/**
 * Moves each item in order, continuing past failures. With
 * `createParents`, a missing destination folder is created first. Nothing
 * is ever overwritten.
 */
export const MoveManyRequest = z.strictObject({
  items: z.array(MoveRequest).min(1).max(1000),
  createParents: z.boolean().optional(),
});

export type MoveManyRequest = z.infer<typeof MoveManyRequest>;

export const MoveManyResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    path: z.string(),
    target: z.string(),
    /** The item moved, but tags, favorites or recents could not follow it. */
    warning: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    path: z.string(),
    target: z.string(),
    error: ApiError.shape.error,
  }),
]);

export type MoveManyResult = z.infer<typeof MoveManyResult>;

export const MoveManyResponse = z.object({
  results: z.array(MoveManyResult),
});

export type MoveManyResponse = z.infer<typeof MoveManyResponse>;

export const CopyRequest = z.object({
  path: z.string(),
  target: z.string(),
});

export type CopyRequest = z.infer<typeof CopyRequest>;

const FORBIDDEN_NAME_CHARS = /[/\0]/;
const nameEncoder = new TextEncoder();

/**
 * True when `name` is safe to use as a single path segment: non-empty, at
 * most 255 UTF-8 bytes, contains neither `/` nor a NUL byte, and is not `.`
 * or `..`.
 */
export function isValidEntryName(name: string): boolean {
  if (name.length < 1 || nameEncoder.encode(name).length > 255) {
    return false;
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    return false;
  }
  return name !== "." && name !== "..";
}

export const RenameRequest = z.object({
  path: z.string(),
  newName: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => isValidEntryName(value), {
      message: 'must not contain "/" or NUL and must not be "." or ".."',
    }),
});

export type RenameRequest = z.infer<typeof RenameRequest>;

const DeleteItem = z.object({
  path: z.string(),
  kind: z.enum(["file", "dir"]),
});

export const DeleteRequest = z.object({
  items: z.array(DeleteItem).min(1).max(1000),
});

export type DeleteRequest = z.infer<typeof DeleteRequest>;

export const ZipRequest = z.object({
  paths: z.array(z.string()).min(1).max(1000),
  name: z.string().optional(),
});

export type ZipRequest = z.infer<typeof ZipRequest>;

export const EntryResponse = FsEntry;

export type EntryResponse = z.infer<typeof EntryResponse>;

export const OkResponse = z.object({
  ok: z.literal(true),
});

export type OkResponse = z.infer<typeof OkResponse>;

export const DuplicateRequest = z.object({
  path: z.string(),
});

export type DuplicateRequest = z.infer<typeof DuplicateRequest>;

/**
 * Builds an archive from `paths` (all of which must live in the same parent
 * folder) in `format`, named `name` (default: derived from the selection)
 * without an extension, written to `destination` (default: the paths'
 * common parent folder). Runs as a job; the response is a `JobAccepted`.
 */
export const CompressRequest = z.object({
  paths: z.array(z.string()).min(1).max(1000),
  format: ArchiveFormat,
  name: z.string().min(1).optional(),
  destination: z.string().optional(),
});

export type CompressRequest = z.infer<typeof CompressRequest>;

/**
 * Extracts the archive at `path` into `destination` (default: a folder
 * beside the archive named after it, minus its archive extension). Runs as
 * a job; the response is a `JobAccepted`.
 */
export const ExtractRequest = z.object({
  path: z.string(),
  destination: z.string().optional(),
});

export type ExtractRequest = z.infer<typeof ExtractRequest>;

/** The archive formats `GET /fs/archive-entries` can list, a superset of
 * `@fdrive/core`'s tar-family `ArchiveKind` plus `zip` (a bare `.gz`, whose
 * single member has no entries of its own, is not included). */
export const ArchiveEntriesFormat = z.enum(["zip", "tar", "tar.gz", "tar.zst"]);

export type ArchiveEntriesFormat = z.infer<typeof ArchiveEntriesFormat>;

/** One entry as listed by `GET /fs/archive-entries`: `path` is the raw
 * path stored inside the archive (not an fdrive virtual filesystem path,
 * and never resolved against one), reported as-is even for a name
 * containing `..` or an absolute root, which is always reported with
 * `kind: "file"` regardless of a trailing slash in its raw name. */
export const ArchiveEntry = z.object({
  path: z.string(),
  kind: z.enum(["file", "dir"]),
  size: z.number().int().min(0),
  modifiedAt: z.iso.datetime().nullable(),
});

export type ArchiveEntry = z.infer<typeof ArchiveEntry>;

/**
 * Returned by `GET /fs/archive-entries`: the archive's format, its entries
 * (bounded at 5000, sorted by `path`), and whether that bound was hit.
 */
export const ArchiveEntriesResponse = z.object({
  format: ArchiveEntriesFormat,
  entries: z.array(ArchiveEntry),
  truncated: z.boolean(),
});

export type ArchiveEntriesResponse = z.infer<typeof ArchiveEntriesResponse>;
