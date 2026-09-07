import { describe, expect, it } from "vitest";
import {
  isOfficeFilename,
  isOfficePath,
  OfficeCreateDocumentRequest,
  OfficeCreateDocumentResponse,
  OfficeOpenRequest,
  OfficeOpenResponse,
  OfficeStatusResponse,
} from "./office.ts";

describe("office contracts", () => {
  it.each(["file.docx", "Årsrapport.odt", "🚀.pptx"])("accepts safe filename %s", (name) =>
    expect(isOfficeFilename(name)).toBe(true),
  );
  it.each([
    "",
    ".",
    "..",
    "a/b",
    "a\\b",
    "a\0b",
    "a\nb",
    "a".repeat(256),
    "å".repeat(128),
    "\ud800",
  ])("rejects unsafe filename", (name) => expect(isOfficeFilename(name)).toBe(false));
  it.each(["/", "/report.docx", "/sv/å.docx"])("accepts canonical paths", (path) =>
    expect(isOfficePath(path)).toBe(true),
  );
  it.each(["relative", "//a", "/../a", "/./a", "/a/", "/a\0"])(
    "rejects noncanonical paths",
    (path) => expect(isOfficePath(path)).toBe(false),
  );
  it("validates strict open and create requests", () => {
    expect(OfficeOpenRequest.parse({ path: "/a.docx", mode: "edit", ui: "sv-SE" }).mode).toBe(
      "edit",
    );
    expect(
      OfficeOpenRequest.safeParse({ path: "/a.docx", mode: "edit", identityId: "other" }).success,
    ).toBe(false);
    expect(
      OfficeOpenRequest.safeParse({ path: "/a.docx", mode: "edit", ui: "javascript:" }).success,
    ).toBe(false);
    expect(OfficeCreateDocumentRequest.parse({ parent: "/", name: "a.XLSX" }).parent).toBe("/");
    expect(OfficeCreateDocumentRequest.safeParse({ parent: "/", name: "a.exe" }).success).toBe(
      false,
    );
  });
  it("validates every response shape", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      OfficeStatusResponse.parse({
        available: false,
        product: null,
        extensions: { view: [], edit: [], convert: [] },
      }).available,
    ).toBe(false);
    expect(OfficeCreateDocumentResponse.parse({ identityId: id, path: "/a.docx" }).path).toBe(
      "/a.docx",
    );
    expect(
      OfficeOpenResponse.parse({
        fileId: id,
        identityId: id,
        path: "/a.docx",
        mode: "view",
        actionUrl: "https://office/editor",
        editorOrigin: "https://office",
        formFields: { access_token: "test" },
        expiresAt: "2026-09-06T00:00:00.000Z",
      }).mode,
    ).toBe("view");
  });
});
