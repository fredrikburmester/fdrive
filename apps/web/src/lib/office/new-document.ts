import { isOfficeFilename } from "@fdrive/contracts";
export type OfficeDocumentKind = "document" | "spreadsheet" | "presentation";
export type OfficeDocumentFormat = "ooxml" | "odf";
export const OFFICE_DOCUMENT_LABELS: Readonly<Record<OfficeDocumentKind, string>> = {
  document: "Document",
  spreadsheet: "Spreadsheet",
  presentation: "Presentation",
};
const EXTENSIONS = {
  document: { ooxml: "docx", odf: "odt" },
  spreadsheet: { ooxml: "xlsx", odf: "ods" },
  presentation: { ooxml: "pptx", odf: "odp" },
} as const;
export function officeDocumentExtension(
  kind: OfficeDocumentKind,
  format: OfficeDocumentFormat,
): string {
  return EXTENSIONS[kind][format];
}
export function officeDocumentName(
  name: string,
  kind: OfficeDocumentKind,
  format: OfficeDocumentFormat,
): string {
  return `${name.replace(/\.(docx|xlsx|pptx|odt|ods|odp)$/i, "")}.${officeDocumentExtension(kind, format)}`;
}
export function validateOfficeDocumentName(
  name: string,
  kind: OfficeDocumentKind,
  format: OfficeDocumentFormat,
): string | null {
  if (!isOfficeFilename(name) || name.trim().length === 0)
    return "Use a file name without slashes or control characters, up to 255 bytes.";
  if (!name.toLowerCase().endsWith(`.${officeDocumentExtension(kind, format)}`))
    return `The file name must end in .${officeDocumentExtension(kind, format)}.`;
  return null;
}
