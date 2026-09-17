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

const TrashPath = z.string().refine((value) => value !== "/" && isValidPath(value), {
  message: "path must be a normalized absolute directory other than the root",
});

/**
 * How deleted files reach a provider's recycle folder: the backend's own
 * rule (`native`, SFTPGo's Event Manager), fdrive moving them itself
 * (`move`), or no Trash at all (`none`). Mirrors core's `TrashStrategy`;
 * it is the active provider module's, never stored.
 */
export const TrashStrategy = z.enum(["native", "move", "none"]);
export type TrashStrategy = z.infer<typeof TrashStrategy>;

const TrashSettingsFields = z.object({
  providerId: z.uuid(),
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  path: TrashPath,
  retentionHours: z.number().int().positive().nullable(),
  /** Only meaningful for `native`: the operator tested the backend's recycle rule. */
  rulesConfirmed: z.boolean(),
});

/** The provider-bound Trash configuration as stored, without the module's strategy. */
export const TrashConfiguration = TrashSettingsFields.strict();
export type TrashConfiguration = z.infer<typeof TrashConfiguration>;

/** Provider-bound Trash configuration plus the active provider's strategy. */
export const TrashSettings = TrashSettingsFields.extend({ strategy: TrashStrategy })
  .strict()
  .refine((value) => !value.enabled || value.strategy !== "none", {
    message: "this storage provider has no Trash",
    path: ["enabled"],
  })
  .refine((value) => !value.enabled || value.strategy !== "native" || value.rulesConfirmed, {
    message: "SFTPGo trash rules must be confirmed before Trash can be enabled",
    path: ["rulesConfirmed"],
  });
export type TrashSettings = z.infer<typeof TrashSettings>;

export const TrashSettingsUpdateRequest = TrashSettings;
export type TrashSettingsUpdateRequest = z.infer<typeof TrashSettingsUpdateRequest>;

/** `GET /api/v1/system/trash` names the storage server whose Trash it reads. */
export const SystemTrashQuery = z.object({ providerId: z.uuid() });
export type SystemTrashQuery = z.infer<typeof SystemTrashQuery>;

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
