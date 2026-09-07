import { expect, it } from "vitest";
import {
  type OfficeDocumentKind,
  officeDocumentExtension,
  officeDocumentName,
  validateOfficeDocumentName,
} from "./new-document";

it("creates all OOXML and ODF names, replacing recognized extensions", () => {
  const expected = {
    document: ["docx", "odt"],
    spreadsheet: ["xlsx", "ods"],
    presentation: ["pptx", "odp"],
  };
  for (const kind of Object.keys(expected) as OfficeDocumentKind[]) {
    for (const [index, format] of (["ooxml", "odf"] as const).entries()) {
      expect(officeDocumentExtension(kind, format)).toBe(expected[kind][index]);
      const name = officeDocumentName("Untitled.DOCX", kind, format);
      expect(name).toBe(`Untitled.${expected[kind][index]}`);
      expect(validateOfficeDocumentName(name, kind, format)).toBeNull();
    }
  }
  expect(officeDocumentName("report.v2", "document", "ooxml")).toBe("report.v2.docx");
});
it("rejects unsafe and mismatched filenames", () => {
  for (const name of ["", " ", "../file.docx", "a\0.docx", "x".repeat(256)])
    expect(validateOfficeDocumentName(name, "document", "ooxml")).toContain("file name");
  expect(validateOfficeDocumentName("report.odt", "document", "ooxml")).toContain(".docx");
});
