import { z } from "zod";

export const OfficeMode = z.enum(["view", "edit", "convert"]);
export type OfficeMode = z.infer<typeof OfficeMode>;
export function isOfficeFilename(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    new TextEncoder().encode(name).length <= 255 &&
    !/[\\/\p{Cc}]/u.test(name) &&
    !/[\uD800-\uDFFF]/u.test(name)
  );
}
export function isOfficePath(path: string): boolean {
  return path.startsWith("/") && (path === "/" || path.slice(1).split("/").every(isOfficeFilename));
}
const officePath = z.string().max(4096).refine(isOfficePath);
export const OfficeOpenRequest = z.strictObject({
  path: officePath,
  mode: OfficeMode,
  ui: z
    .string()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/)
    .max(32)
    .optional(),
});
export type OfficeOpenRequest = z.infer<typeof OfficeOpenRequest>;
export const OfficeOpenResponse = z.object({
  fileId: z.uuid(),
  identityId: z.uuid(),
  path: officePath,
  mode: OfficeMode,
  actionUrl: z.url(),
  editorOrigin: z.url(),
  formFields: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type OfficeOpenResponse = z.infer<typeof OfficeOpenResponse>;
export const OfficeStatusResponse = z.object({
  available: z.boolean(),
  product: z.enum(["onlyoffice", "collabora"]).nullable(),
  extensions: z.object({
    view: z.array(z.string()),
    edit: z.array(z.string()),
    convert: z.array(z.string()),
  }),
});
export type OfficeStatusResponse = z.infer<typeof OfficeStatusResponse>;

const OfficeAppUrl = z
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (url.pathname === "" || url.pathname === "/")
    );
  }, "appUrl must be an HTTP(S) origin without credentials, path, query, or fragment")
  .transform((value) => new URL(value).origin);

/** Owner-controlled activation and browser origin for the configured Office service. */
export const OfficeSettings = z
  .object({
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    appUrl: OfficeAppUrl.nullable(),
    editingEnabled: z.boolean(),
    editingProviderId: z.uuid().nullable(),
    editorUsernames: z.array(z.string().min(1).max(255)).max(1000),
  })
  .strict()
  .refine((value) => !value.enabled || value.appUrl !== null, {
    message: "appUrl is required when Office is enabled",
    path: ["appUrl"],
  })
  .refine(
    (value) =>
      !value.editingEnabled ||
      (value.editingProviderId !== null && value.editorUsernames.length > 0),
    {
      message: "editing requires a provider and at least one SFTPGo username",
      path: ["editorUsernames"],
    },
  )
  .refine((value) => new Set(value.editorUsernames).size === value.editorUsernames.length, {
    message: "editor usernames must be unique",
    path: ["editorUsernames"],
  });
export type OfficeSettings = z.infer<typeof OfficeSettings>;

export const OfficeSettingsUpdateRequest = OfficeSettings;
export type OfficeSettingsUpdateRequest = z.infer<typeof OfficeSettingsUpdateRequest>;

export const SystemOfficeResponse = z.object({
  configuration: OfficeSettings,
  product: z.enum(["onlyoffice", "collabora"]),
  status: z.enum(["off", "starting", "ready", "unavailable"]),
  activeProviderId: z.uuid().nullable(),
});
export type SystemOfficeResponse = z.infer<typeof SystemOfficeResponse>;

/** Minimal desired state returned to the bundled Office runtime controller. */
export const OfficeRuntimeConfiguration = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
});
export type OfficeRuntimeConfiguration = z.infer<typeof OfficeRuntimeConfiguration>;
export const OfficeCreateDocumentRequest = z.strictObject({
  parent: officePath,
  name: z
    .string()
    .refine(isOfficeFilename)
    .regex(/\.(docx|xlsx|pptx|odt|ods|odp)$/i),
});
export type OfficeCreateDocumentRequest = z.infer<typeof OfficeCreateDocumentRequest>;
export const OfficeCreateDocumentResponse = z.object({ identityId: z.uuid(), path: officePath });
export type OfficeCreateDocumentResponse = z.infer<typeof OfficeCreateDocumentResponse>;
