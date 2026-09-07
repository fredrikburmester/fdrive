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
