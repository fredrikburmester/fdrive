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

  it("prefers the code extension over a colliding media mime for .ts files", () => {
    // `.ts` legacy servers may report `video/mp2t` (MPEG transport stream),
    // but a `.ts` file is almost always TypeScript source in a file manager.
    expect(fileIconKind({ kind: "file", ext: ".ts", mime: "video/mp2t" })).toBe("code");
  });

  it("recognizes .mts and .cts as code, even with a colliding video mime", () => {
    expect(fileIconKind({ kind: "file", ext: ".mts", mime: "video/mp2t" })).toBe("code");
    expect(fileIconKind({ kind: "file", ext: ".cts", mime: null })).toBe("code");
  });

  it("recognizes .tsx as code", () => {
    expect(fileIconKind({ kind: "file", ext: ".tsx", mime: null })).toBe("code");
  });

  it("still shows a video icon for a real video file", () => {
    expect(fileIconKind({ kind: "file", ext: ".mp4", mime: "video/mp4" })).toBe("video");
  });

  it("shows a video icon for an .m2ts transport stream, which is not a code extension", () => {
    expect(fileIconKind({ kind: "file", ext: ".m2ts", mime: "video/mp2t" })).toBe("video");
  });
});
