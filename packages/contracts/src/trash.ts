import { z } from "zod";
import { FsEntry, isValidEntryName } from "./fs.ts";

/**
 * True when `path` is an absolute, well-formed virtual path: it starts with
 * "/", the root itself is valid, and every other segment is a safe entry
 * name (see `isValidEntryName`).
 */
export function isValidPath(path: string): boolean {
  if (!path.startsWith("/")) {
    return false;
  }
  if (path === "/") {
    return true;
  }
  return path
    .slice(1)
    .split("/")
    .every((segment) => isValidEntryName(segment));
}

/** Whether the active identity's storage provider exposes a trash, and its configuration. */
export const TrashStatusResponse = z.object({
  available: z.boolean(),
  /** The provider's trash path, when available. */
  path: z.string().nullable(),
  /** Informational only: fdrive never enforces retention itself. */
  retentionHours: z.number().int().positive().nullable(),
});

export type TrashStatusResponse = z.infer<typeof TrashStatusResponse>;

/** One deleted item still recoverable from the trash. */
export const TrashEntry = z.object({
  id: z.string(),
  originalPath: z.string(),
  name: z.string(),
  size: z.number().int().min(0),
  deletedAt: z.iso.datetime(),
});

export type TrashEntry = z.infer<typeof TrashEntry>;

export const TrashListResponse = z.object({
  entries: z.array(TrashEntry),
  truncated: z.boolean(),
});

export type TrashListResponse = z.infer<typeof TrashListResponse>;

/**
 * Restores one or more trash entries. `target` (default: each entry's
 * original path) is only accepted when restoring exactly one id.
 */
export const TrashRestoreRequest = z
  .object({
    ids: z.array(z.string()).min(1).max(1000),
    target: z
      .string()
      .refine((value) => isValidPath(value), { message: "target must be a valid absolute path" })
      .optional(),
  })
  .refine((value) => value.target === undefined || value.ids.length === 1, {
    message: "target is only allowed when restoring exactly one id",
    path: ["target"],
  });

export type TrashRestoreRequest = z.infer<typeof TrashRestoreRequest>;

export const TrashRestoreResponse = z.object({
  restored: z.array(FsEntry),
});

export type TrashRestoreResponse = z.infer<typeof TrashRestoreResponse>;

export const TrashPurgeRequest = z.object({
  ids: z.array(z.string()).min(1).max(1000),
});

export type TrashPurgeRequest = z.infer<typeof TrashPurgeRequest>;
