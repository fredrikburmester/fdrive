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

const officeSettingsShape = {
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  editingEnabled: z.boolean(),
  editingProviderId: z.uuid().nullable(),
  editorUsernames: z.array(z.string().min(1).max(255)).max(1000),
};

function withOfficeRules<T extends z.ZodType<z.infer<z.ZodObject<typeof officeSettingsShape>>>>(
  schema: T,
) {
  return schema
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
}

/**
 * Owner-controlled activation of the configured Office service. The
 * browser origin the editor is told fdrive lives at is the system-wide
 * `PublicUrlSettings`, not part of this record. Stored rows written before
 * that split carry an `appUrl` key; parsing strips it (the update request
 * below stays strict).
 */
export const OfficeSettings = withOfficeRules(z.object(officeSettingsShape));
export type OfficeSettings = z.infer<typeof OfficeSettings>;

export const OfficeSettingsUpdateRequest = withOfficeRules(z.strictObject(officeSettingsShape));
export type OfficeSettingsUpdateRequest = z.infer<typeof OfficeSettingsUpdateRequest>;

export const SystemOfficeResponse = z.object({
  configuration: OfficeSettings,
  product: z.enum(["onlyoffice", "collabora"]),
  status: z.enum(["off", "starting", "ready", "unavailable"]),
  /** The storage server editor grants apply to: the installation's default provider. */
  activeProviderId: z.uuid().nullable(),
  activeProviderLabel: z.string().nullable(),
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
