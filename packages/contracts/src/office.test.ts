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
import { PublicUrlSettings } from "./public-url.ts";

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
  it("requires an explicit bound editor allowlist", () => {
    const providerId = "123e4567-e89b-42d3-a456-426614174000";
    const settings = OfficeSettingsUpdateRequest.parse({
      revision: 0,
      enabled: true,
      editingEnabled: true,
      editingProviderId: providerId,
      editorUsernames: ["alice"],
    });
    expect(
      SystemOfficeResponse.parse({
        configuration: settings,
        product: "onlyoffice",
        status: "starting",
        activeProviderId: providerId,
        activeProviderLabel: "Primary",
      }).status,
    ).toBe("starting");
    expect(OfficeSettings.safeParse({ ...settings, editingProviderId: null }).success).toBe(false);
    expect(OfficeSettings.safeParse({ ...settings, editorUsernames: [] }).success).toBe(false);
  });
  it("strips the appUrl of rows stored before the address became system-wide, but rejects it in requests", () => {
    const legacy = {
      revision: 3,
      enabled: true,
      appUrl: "https://drive.example",
      editingEnabled: false,
      editingProviderId: null,
      editorUsernames: [],
    };
    expect(OfficeSettings.parse(legacy)).toEqual({
      revision: 3,
      enabled: true,
      editingEnabled: false,
      editingProviderId: null,
      editorUsernames: [],
    });
    expect(OfficeSettingsUpdateRequest.safeParse(legacy).success).toBe(false);
  });
});

describe("public URL contracts", () => {
  it("normalizes a safe origin", () => {
    expect(PublicUrlSettings.parse({ revision: 0, url: "https://drive.example/" })).toEqual({
      revision: 0,
      url: "https://drive.example",
    });
    expect(PublicUrlSettings.parse({ revision: 0, url: null }).url).toBeNull();
    expect(PublicUrlSettings.parse({ revision: 0, url: "http://192.168.1.10:8090" }).url).toBe(
      "http://192.168.1.10:8090",
    );
  });
  it.each([
    "invalid",
    "",
    "ftp://drive.example",
    "https://user:secret@drive.example",
    "https://drive.example/path",
    "https://drive.example?token=secret",
    "https://drive.example#fragment",
  ])("rejects unsafe address %s", (url) => {
    expect(PublicUrlSettings.safeParse({ revision: 0, url }).success).toBe(false);
  });
});
