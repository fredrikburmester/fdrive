import { describe, expect, it } from "vitest";
import { fileIconKind } from "./icon-kind";

describe("fileIconKind", () => {
  it("returns folder for directories regardless of mime or ext", () => {
    expect(fileIconKind({ kind: "dir", ext: "", mime: null })).toBe("folder");
  });

  it("prefers an image mime over the extension", () => {
    expect(fileIconKind({ kind: "file", ext: ".bin", mime: "image/png" })).toBe("image");
  });

  it("recognizes video mime types", () => {
    expect(fileIconKind({ kind: "file", ext: ".mp4", mime: "video/mp4" })).toBe("video");
  });

  it("recognizes audio mime types", () => {
    expect(fileIconKind({ kind: "file", ext: ".mp3", mime: "audio/mpeg" })).toBe("audio");
  });

  it("falls back to the extension for an unrelated mime", () => {
    expect(fileIconKind({ kind: "file", ext: ".zip", mime: "application/zip" })).toBe("archive");
  });

  it("recognizes archive extensions", () => {
    expect(fileIconKind({ kind: "file", ext: ".tar.gz", mime: null })).toBe("archive");
  });

  it("recognizes presentation extensions", () => {
    expect(fileIconKind({ kind: "file", ext: ".pptx", mime: null })).toBe("presentation");
  });

  it("recognizes table extensions", () => {
    expect(fileIconKind({ kind: "file", ext: ".xlsx", mime: null })).toBe("table");
  });

  it("recognizes code extensions", () => {
    expect(fileIconKind({ kind: "file", ext: ".ts", mime: null })).toBe("code");
  });

  it("recognizes text extensions", () => {
    expect(fileIconKind({ kind: "file", ext: ".md", mime: null })).toBe("text");
  });

  it("is case-insensitive on the extension", () => {
    expect(fileIconKind({ kind: "file", ext: ".ZIP", mime: null })).toBe("archive");
  });

  it("falls back to a generic file icon", () => {
    expect(fileIconKind({ kind: "file", ext: ".xyz", mime: null })).toBe("file");
  });

  it("falls back to the extension when mime is null", () => {
    expect(fileIconKind({ kind: "file", ext: ".ts", mime: null })).toBe("code");
  });
});
