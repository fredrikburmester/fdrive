import { z } from "zod";
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

export const DownloadQuery = z.object({
  path: z.string(),
  inline: z.literal("1").optional(),
});

export type DownloadQuery = z.infer<typeof DownloadQuery>;

export const UploadQuery = z.object({
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

export const CopyRequest = z.object({
  path: z.string(),
  target: z.string(),
});

export type CopyRequest = z.infer<typeof CopyRequest>;

const FORBIDDEN_NAME_CHARS = /[/\0]/;

/**
 * True when `name` is safe to use as a single path segment: non-empty, at
 * most 255 characters, contains neither `/` nor a NUL byte, and is not `.`
 * or `..`.
 */
export function isValidEntryName(name: string): boolean {
  if (name.length < 1 || name.length > 255) {
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
