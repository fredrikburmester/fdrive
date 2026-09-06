import { describe, expect, it } from "vitest";
import { defaultArchiveName, extractDestinationUnder } from "./archive";

describe("defaultArchiveName", () => {
  it("uses the single entry's base name, stripping its extension", () => {
    expect(defaultArchiveName(["/a/readme.md"])).toBe("readme");
  });

  it("uses a single folder's name as-is (no extension to strip)", () => {
    expect(defaultArchiveName(["/a/docs"])).toBe("docs");
  });

  it("uses the common parent folder's name for several entries", () => {
    expect(defaultArchiveName(["/a/x.txt", "/a/y.txt"])).toBe("a");
  });

  it("falls back to 'archive' when several entries live at the root", () => {
    expect(defaultArchiveName(["/x.txt", "/y.txt"])).toBe("archive");
  });

  it("falls back to 'archive' for an empty selection", () => {
    expect(defaultArchiveName([])).toBe("archive");
  });

  it("keeps a dotfile's name as-is (no extension per extensionOf's rules)", () => {
    expect(defaultArchiveName(["/a/.env"])).toBe(".env");
  });
});

describe("extractDestinationUnder", () => {
  it("joins the chosen folder with the archive's name, minus its archive extension", () => {
    expect(extractDestinationUnder("/a/docs.zip", "/b")).toBe("/b/docs");
  });

  it("strips a compound archive extension", () => {
    expect(extractDestinationUnder("/a/docs.tar.gz", "/b")).toBe("/b/docs");
  });

  it("leaves a name with no recognized archive extension unchanged", () => {
    expect(extractDestinationUnder("/a/docs", "/b")).toBe("/b/docs");
  });
});
