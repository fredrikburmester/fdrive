import { z } from "zod";
import { CanonicalUuid } from "./canonical-uuid.ts";

export const DESKTOP_API = "/api/v1/desktop";
export const DESKTOP_PROTOCOL_VERSION = 1;
export const DesktopPath = z
  .string()
  .min(1)
  .max(4096)
  .startsWith("/")
  .refine(
    (value) => ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    "Invalid path",
  );
export const DesktopPairRequest = z.strictObject({ deviceName: z.string().trim().min(1).max(100) });
export const DesktopPairApproval = z.strictObject({
  identityIds: z.array(CanonicalUuid).min(1).max(16),
  access: z.record(CanonicalUuid, z.enum(["read", "full"])).optional(),
});
export const DesktopPairSecret = z.strictObject({
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const DesktopPairing = z.object({
  id: z.uuid(),
  secret: z.string(),
  code: z.string(),
  expiresAt: z.iso.datetime(),
});
export const DesktopPairInfo = z.object({
  deviceName: z.string(),
  code: z.string(),
  expiresAt: z.iso.datetime(),
  approved: z.boolean(),
  supportsWrites: z.boolean().optional(),
});
export const DesktopLocation = z.object({
  protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
  accountId: z.uuid(),
  identityId: z.uuid(),
  providerId: z.uuid(),
  displayName: z.string(),
  username: z.string(),
  paths: z.array(DesktopPath),
  readOnly: z.literal(true),
});
export const DesktopCredential = z.object({
  token: z.string(),
  tokenId: z.uuid(),
  expiresAt: z.iso.datetime(),
  location: DesktopLocation,
});
export const DesktopPairResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("connected"), credentials: z.array(DesktopCredential) }),
]);
export const DesktopEntry = z.object({
  path: DesktopPath,
  name: z.string(),
  kind: z.enum(["file", "dir", "symlink", "other"]),
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime(),
  readable: z.boolean(),
});
export const DesktopListing = z.object({
  entries: z.array(DesktopEntry),
  nextCursor: z.string().nullable(),
});
export const DesktopVersionRequest = z.strictObject({ paths: z.array(DesktopPath).min(1).max(16) });
export const DesktopVersion = z.object({
  path: DesktopPath,
  version: z.string(),
  size: z.number().int().nonnegative(),
});
export type DesktopLocation = z.infer<typeof DesktopLocation>;
export type DesktopCredential = z.infer<typeof DesktopCredential>;
export type DesktopEntry = z.infer<typeof DesktopEntry>;
