import { z } from "zod";
import { CanonicalUuid } from "./canonical-uuid.ts";
import { DesktopEntry, DesktopLocation } from "./desktop.ts";

/** Protocol 1 stays read-only for installed clients. */
export const DESKTOP_WRITE_API = "/api/v2/desktop";
export const DesktopAccessMode = z.enum(["read", "full"]);
export const DesktopWriteApproval = z.strictObject({
  identityIds: z.array(CanonicalUuid).min(1).max(16),
  access: z.record(CanonicalUuid, DesktopAccessMode).optional(),
});
export const DesktopWriteCapabilities = z.object({
  create: z.boolean(),
  update: z.boolean(),
  move: z.boolean(),
  trash: z.boolean(),
  restore: z.boolean(),
});
export const DesktopWriteLocation = DesktopLocation.extend({
  protocolVersion: z.literal(2),
  readOnly: z.boolean(),
  capabilities: DesktopWriteCapabilities,
  maxUploadBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  writeUnavailableReason: z.string().optional(),
});
export const DesktopWriteCredential = z.object({
  token: z.string(),
  tokenId: CanonicalUuid,
  expiresAt: z.iso.datetime(),
  location: DesktopWriteLocation,
});
export const DesktopWritePairResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("connected"), credentials: z.array(DesktopWriteCredential) }),
]);
export const DesktopItemId = z.union([CanonicalUuid, z.literal("root"), z.literal("trash")]);
export const DesktopName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      ![".", ".."].includes(value) &&
      !/[/:]/.test(value) &&
      new TextEncoder().encode(value).byteLength <= 255 &&
      ![...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    "Invalid filename",
  );
export const DesktopBaseVersion = z.object({
  content: z.string().min(1).max(256),
  metadata: z.string().min(1).max(256),
});
export const DesktopWriteEntry = DesktopEntry.extend({
  id: DesktopItemId,
  parentId: DesktopItemId,
  version: DesktopBaseVersion,
  capabilities: DesktopWriteCapabilities,
  trashed: z.boolean(),
});
export const DesktopWriteListing = z.object({
  entries: z.array(DesktopWriteEntry),
  nextCursor: z.string().nullable(),
});
const OperationId = CanonicalUuid;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DesktopUploadRequest = z.strictObject({
  operationId: OperationId,
  itemId: DesktopItemId.optional(),
  parentId: DesktopItemId,
  name: DesktopName,
  base: DesktopBaseVersion.nullable(),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: Digest,
});
export const DesktopFolderRequest = z.strictObject({
  operationId: OperationId,
  parentId: DesktopItemId,
  name: DesktopName,
});
export const DesktopMoveRequest = z.strictObject({
  operationId: OperationId,
  itemId: DesktopItemId,
  parentId: DesktopItemId,
  name: DesktopName,
  base: DesktopBaseVersion,
});
export const DesktopTrashRequest = z.strictObject({
  operationId: OperationId,
  itemId: DesktopItemId,
  base: DesktopBaseVersion,
});
export const DesktopOperationState = z.enum([
  "receiving",
  "uploading",
  "ready",
  "committing",
  "completed",
  "conflict",
  "uncertain",
  "cancelled",
  "acknowledged",
]);
/**
 * How far a publication that runs for long enough to be worth watching has got,
 * in bytes so a folder of uneven files advances evenly. Only a publication that
 * copies object by object reports it; everything else publishes in one step and
 * has nothing to show. `total` is settled before the first byte moves.
 */
export const DesktopOperationProgress = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export const DesktopOperationResult = z.object({
  operationId: OperationId,
  state: DesktopOperationState,
  item: DesktopWriteEntry.nullable(),
  /** A post-commit recovery copy, if one was retained. Never an upstream path. */
  recoveryId: CanonicalUuid.nullable(),
  progress: DesktopOperationProgress.optional(),
});
export const DesktopWriteErrorCode = z.enum([
  "version_conflict",
  "name_collision",
  "permission_denied",
  "quota_exceeded",
  "operation_uncertain",
  "operation_cancelled",
  "operation_expired",
  "unsupported",
  "invalid_upload",
]);
export type DesktopWriteLocation = z.infer<typeof DesktopWriteLocation>;
export type DesktopWriteEntry = z.infer<typeof DesktopWriteEntry>;
export type DesktopWriteCredential = z.infer<typeof DesktopWriteCredential>;
export type DesktopWriteCapabilities = z.infer<typeof DesktopWriteCapabilities>;
export type DesktopUploadRequest = z.infer<typeof DesktopUploadRequest>;
export type DesktopFolderRequest = z.infer<typeof DesktopFolderRequest>;
export type DesktopMoveRequest = z.infer<typeof DesktopMoveRequest>;
export type DesktopTrashRequest = z.infer<typeof DesktopTrashRequest>;
export type DesktopOperationProgress = z.infer<typeof DesktopOperationProgress>;
export type DesktopOperationResult = z.infer<typeof DesktopOperationResult>;
export type DesktopBaseVersion = z.infer<typeof DesktopBaseVersion>;
export type DesktopAccessMode = z.infer<typeof DesktopAccessMode>;
