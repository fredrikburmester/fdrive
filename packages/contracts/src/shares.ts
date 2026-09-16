import { z } from "zod";
import { CanonicalUuid } from "./canonical-uuid.ts";

export const ShareId = CanonicalUuid;
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
/**
 * A share's download limit is stored by SFTPGo, not by fdrive: it travels as
 * `max_tokens`, a column SFTPGo's PostgreSQL and MySQL data providers declare
 * `integer`. Signed 32-bit is therefore the largest limit every supported
 * provider can hold, so requests are bounded here instead of failing inside
 * SFTPGo. Responses stay unbounded: they must keep reading whatever limit a
 * share already carries.
 */
export const MAX_SHARE_DOWNLOADS = 2_147_483_647;
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
  maxDownloads: z.number().int().min(0).max(MAX_SHARE_DOWNLOADS).default(0),
  password: z.string().max(1024).optional(),
  presentation: SharePresentation.default("auto"),
});
export type CreateShareRequest = z.infer<typeof CreateShareRequest>;
export const UpdateShareRequest = CreateShareRequest.extend({
  description: z.string().max(2048),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  maxDownloads: z.number().int().min(0).max(MAX_SHARE_DOWNLOADS),
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
  /** Consumed provider transfer tokens: downloads/previews for read shares, uploads for write shares. */
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
  /** Consumed provider transfer tokens: downloads/previews for read shares, uploads for write shares. */
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
 * Camera raw extensions the indexer thumbnails (from the camera's embedded JPEG preview).
 * No browser decodes these, so every surface shows the thumbnail and offers the original as a
 * download. Mirrors `RAW_EXTS` in the indexer's `chunking.py`.
 */
export const RAW_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".arw",
  ".sr2",
  ".srf",
  ".cr2",
  ".cr3",
  ".crw",
  ".nef",
  ".nrw",
  ".dng",
  ".raf",
  ".orf",
  ".rw2",
  ".pef",
]);

/**
 * Extensions the public gallery renders as image tiles for `auto` presentation. Shared by the
 * API (deciding what counts as "every shared file is an image") and the web app (the same check
 * client-side, without another round trip). SVG is excluded: the gallery treats SVG as
 * download-only. HEIC/HEIF files are included: the frontend handles thumbnails and client-side
 * WASM/picture viewing. Camera raw files are included: tiles and the lightbox show the
 * indexer's thumbnail.
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
  ...RAW_IMAGE_EXTENSIONS,
]);

/** True when `name`'s extension (case-insensitive) is one the public gallery treats as an image. */
export function isImageFileName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}
