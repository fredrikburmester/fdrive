import { describe, expect, it } from "vitest";
import {
  officeFolderHref,
  officeHostTarget,
  officeHref,
  officeMode,
  officePathFromSegments,
  renamedOfficePath,
} from "./route";

describe("office routes", () => {
  it("defaults to view and encodes file segments", () => {
    for (const value of [undefined, "view", "bad", ["edit"]])
      expect(officeMode(value)).toBe("view");
    expect(officeMode("edit")).toBe("edit");
    expect(officeMode("convert")).toBe("convert");
    expect(officeHref("/Å/a#b.docx")).toBe("/office/%C3%85/a%23b.docx?mode=view");
    expect(officePathFromSegments(["%C3%85", "a%23b.docx"])).toBe("/Å/a#b.docx");
    expect(officePathFromSegments(["a%20b.docx"])).toBe("/a b.docx");
    expect(officePathFromSegments(["a%2520b.docx"])).toBe("/a%20b.docx");
    expect(officeFolderHref("/folder/a.docx")).toBe("/files/folder");
    expect(officeFolderHref("/a.docx")).toBe("/files");
  });
  it("rejects invalid paths", () => {
    for (const path of ["/", "bad", "/a\0.docx"]) expect(() => officeHref(path)).toThrow();
    expect(() => officePathFromSegments([])).toThrow();
    for (const segment of ["a\0.docx", "a%00.docx", "bad%XY.docx", "%2e%2e", "a%2fb.docx"])
      expect(() => officePathFromSegments([segment])).toThrow();
  });
  it("constructs safe rename candidates", () => {
    expect(renamedOfficePath("/old.docx", "new.docx")).toBe("/new.docx");
    expect(renamedOfficePath("/folder/old.docx", "new.docx")).toBe("/folder/new.docx");
    expect(renamedOfficePath("/old.docx", "new")).toBe("/new.docx");
    expect(renamedOfficePath("/old", "new")).toBe("/new");
    expect(renamedOfficePath("/old.docx", "x".repeat(255))).toBeNull();
    for (const name of ["../new", "", "..", "bad\0"])
      expect(renamedOfficePath("/old", name)).toBeNull();
  });
  it("allows only same-origin token-free office destinations", () => {
    expect(officeHostTarget("/office/new.docx?mode=edit", "https://host.test")).toBe(
      "/office/new.docx?mode=edit",
    );
    expect(officeHostTarget("https://host.test/office/team/new.docx", "https://host.test")).toBe(
      "/office/team/new.docx?mode=view",
    );
    expect(officeHostTarget("/office/a%2520b.docx", "https://host.test")).toBe(
      "/office/a%2520b.docx?mode=view",
    );
    for (const href of [
      "https://evil.test/office/a.docx",
      "/files",
      "/office/a.docx?access_token=secret",
      "/office/a.docx#hash",
      "https://user:pass@host.test/office/a.docx",
      "https://:bad",
      "/office/",
      "/office/bad%XY.docx",
    ])
      expect(officeHostTarget(href, "https://host.test")).toBeNull();
  });
});
