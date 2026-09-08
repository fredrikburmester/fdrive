import { describe, expect, it } from "vitest";
import {
  isOfficeFilename,
  isOfficePath,
  OfficeCreateDocumentRequest,
  OfficeCreateDocumentResponse,
  OfficeOpenRequest,
  OfficeOpenResponse,
  OfficeSettings,
  OfficeSettingsUpdateRequest,
  OfficeStatusResponse,
  SystemOfficeResponse,
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
  it("normalizes safe Office origins and requires an explicit bound editor allowlist", () => {
    const providerId = "123e4567-e89b-42d3-a456-426614174000";
    const settings = OfficeSettingsUpdateRequest.parse({
      revision: 0,
      enabled: true,
      appUrl: "https://drive.example/",
      editingEnabled: true,
      editingProviderId: providerId,
      editorUsernames: ["alice"],
    });
    expect(settings.appUrl).toBe("https://drive.example");
    expect(
      SystemOfficeResponse.parse({
        configuration: settings,
        product: "onlyoffice",
        status: "starting",
        activeProviderId: providerId,
      }).status,
    ).toBe("starting");
    expect(OfficeSettings.safeParse({ ...settings, editingProviderId: null }).success).toBe(false);
    expect(OfficeSettings.safeParse({ ...settings, editorUsernames: [] }).success).toBe(false);
  });
  it.each([
    "invalid",
    "",
    "ftp://drive.example",
    "https://user:secret@drive.example",
    "https://drive.example/path",
    "https://drive.example?token=secret",
    "https://drive.example#fragment",
  ])("rejects unsafe Office app URL %s", (appUrl) => {
    expect(
      OfficeSettings.safeParse({
        revision: 0,
        enabled: true,
        appUrl,
        editingEnabled: false,
        editingProviderId: null,
        editorUsernames: [],
      }).success,
    ).toBe(false);
  });
});
