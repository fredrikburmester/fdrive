import type { FsEntry, OfficeStatusResponse } from "@fdrive/contracts";
import { expect, it } from "vitest";
import { OFFICE_MODE_LABELS, officeModesFor, opensInOffice } from "./capabilities";

const status: OfficeStatusResponse = {
  available: true,
  product: "onlyoffice",
  extensions: { view: ["docx", "pdf", "txt", "pages"], edit: [".DOCX", "txt"], convert: ["doc"] },
};
const entry: FsEntry = {
  path: "/a.docx",
  name: "a.docx",
  kind: "file",
  ext: ".docx",
  mime: null,
  size: 1,
  modifiedAt: "2026-01-01T00:00:00Z",
};
it("matches extension and mode while hiding unavailable, directory, and multi-selection actions", () => {
  expect(officeModesFor(entry, status)).toEqual(["view", "edit"]);
  expect(officeModesFor({ ...entry, name: "legacy.doc" }, status)).toEqual(["convert"]);
  expect(OFFICE_MODE_LABELS.convert).toBe("Convert and edit");
  expect(officeModesFor(entry, undefined)).toEqual([]);
  expect(officeModesFor(entry, { ...status, available: false })).toEqual([]);
  expect(officeModesFor({ ...entry, kind: "dir" }, status)).toEqual([]);
  expect(officeModesFor(entry, status, 2)).toEqual([]);
  expect(officeModesFor({ ...entry, name: "" }, status)).toEqual([]);
});
it("preserves native text and PDF viewers, using office view for supported documents", () => {
  expect(opensInOffice(entry, status)).toBe(true);
  expect(opensInOffice(entry, undefined)).toBe(false);
  expect(opensInOffice({ ...entry, kind: "dir" }, status)).toBe(false);
  for (const ext of ["pdf", "txt"])
    expect(opensInOffice({ ...entry, name: `a.${ext}`, ext: `.${ext}` }, status)).toBe(false);
  expect(opensInOffice({ ...entry, name: "a.pages", ext: ".pages" }, status)).toBe(true);
});
