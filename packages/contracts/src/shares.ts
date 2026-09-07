import { z } from "zod";

export const ShareId = z.uuid().regex(/^[0-9a-f-]+$/);
/** Canonical virtual path. Transport decodes once; literal percent characters are preserved. */
export const SharePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !/[\\\p{Cc}]/u.test(value) &&
      (value === "/" ||
        value
          .slice(1)
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== "..")),
  );
export const ShareScope = z.enum(["read", "write"]);
/** Operator-chosen public page rendering. `auto` picks a shape from the shared files. */
export const SharePresentation = z.enum(["auto", "list", "gallery", "download"]);
export type SharePresentation = z.infer<typeof SharePresentation>;
export const CreateShareRequest = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\p{Cc}]+$/u),
  description: z.string().max(2048).default(""),
  paths: z.array(SharePath).min(1).max(1000),
  scope: ShareScope,
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
  maxDownloads: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  password: z.string().max(1024).optional(),
  presentation: SharePresentation.default("auto"),
});
export type CreateShareRequest = z.infer<typeof CreateShareRequest>;
export const UpdateShareRequest = CreateShareRequest.extend({
  description: z.string().max(2048),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  maxDownloads: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  presentation: SharePresentation,
}).partial();
export type UpdateShareRequest = z.infer<typeof UpdateShareRequest>;
export const ShareLayout = z.enum(["single-file", "directory", "archive"]);
export const ManagedShare = z.object({
  id: ShareId,
  name: z.string(),
  description: z.string(),
  scope: ShareScope,
  paths: z.array(SharePath),
  publicPath: z.string(),
  hasPassword: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  maxDownloads: z.number().int().min(0),
  usedDownloads: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  presentation: SharePresentation,
});
export type ManagedShare = z.infer<typeof ManagedShare>;
export const SharesResponse = z.object({ items: z.array(ManagedShare) });
export type SharesResponse = z.infer<typeof SharesResponse>;
export const PublicShare = z.object({
  name: z.string(),
  description: z.string(),
  scope: ShareScope,
  layout: ShareLayout,
  presentation: SharePresentation,
  fileName: z.string().nullable(),
  hasPassword: z.boolean(),
  credentialPresent: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  maxDownloads: z.number().int().min(0),
  usedDownloads: z.number().int().min(0),
  unavailableReason: z.enum(["expired", "limit"]).nullable(),
});
export type PublicShare = z.infer<typeof PublicShare>;
export const ShareCredentialsRequest = z.strictObject({ password: z.string().max(1024) });
export const PublicShareEntry = z.object({
  name: z.string(),
  kind: z.enum(["file", "dir", "symlink", "other"]),
  size: z.number().min(0),
  modifiedAt: z.iso.datetime(),
});
export const ShareEntriesResponse = z.object({ items: z.array(PublicShareEntry) });
export type ShareEntriesResponse = z.infer<typeof ShareEntriesResponse>;
/** Uploads accept exactly one filename below the shared directory. */
export const ShareUploadPath = SharePath.refine(
  (value) => value !== "/" && !value.slice(1).includes("/"),
);

/**
 * Extensions the public gallery renders as image tiles for `auto` presentation. Shared by the
 * API (deciding what counts as "every shared file is an image") and the web app (the same check
 * client-side, without another round trip). SVG is excluded: the gallery grid feeds these names
 * straight into `img src` on a page that otherwise treats SVG as download-only.
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

/** True when `name`'s extension (case-insensitive) is one the public gallery treats as an image. */
export function isImageFileName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}
