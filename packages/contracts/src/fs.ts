import { z } from "zod";

/**
 * The kind of filesystem entry, mirroring `@fdrive/core`'s `EntryKind` and
 * SFTPGo's own mode bits (`dir`, `symlink`, `file`, `other` for anything
 * that is none of those).
 */
export const EntryKind = z.enum(["file", "dir", "symlink", "other"]);

export type EntryKind = z.infer<typeof EntryKind>;

/**
 * One entry as returned to the browser: normalized kind, size, an ISO
 * `modifiedAt`, and a best-effort `mime` guess (`null` when unknown, always
 * `null` for directories).
 */
export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: EntryKind,
  size: z.number().int().min(0),
  modifiedAt: z.iso.datetime(),
  ext: z.string(),
  mime: z.string().nullable(),
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
