import { describe, expect, it } from "vitest";
import { isInlinePreviewable, mimeFromExtension } from "./mime.ts";

describe("mimeFromExtension", () => {
  it("resolves common web, image, audio, video, document, archive, code, and Office types", () => {
    expect(mimeFromExtension(".html")).toBe("text/html");
    expect(mimeFromExtension(".json")).toBe("application/json");
    expect(mimeFromExtension(".png")).toBe("image/png");
    expect(mimeFromExtension(".mp3")).toBe("audio/mpeg");
    expect(mimeFromExtension(".mp4")).toBe("video/mp4");
    expect(mimeFromExtension(".pdf")).toBe("application/pdf");
    expect(mimeFromExtension(".zip")).toBe("application/zip");
    expect(mimeFromExtension(".tar.gz")).toBe("application/gzip");
    expect(mimeFromExtension(".docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("treats .ts, .mts, and .cts as TypeScript source, not MPEG transport stream video", () => {
    expect(mimeFromExtension(".ts")).toBe("text/typescript");
    expect(mimeFromExtension(".mts")).toBe("text/typescript");
    expect(mimeFromExtension(".cts")).toBe("text/typescript");
    expect(mimeFromExtension(".tsx")).toBe("text/tsx");
  });

  it("resolves real video containers, including the transport stream extension .m2ts", () => {
    expect(mimeFromExtension(".mp4")).toBe("video/mp4");
    expect(mimeFromExtension(".m2ts")).toBe("video/mp2t");
  });

  it("resolves code extensions to their text/* or code-specific mime", () => {
    expect(mimeFromExtension(".py")).toBe("text/x-python");
    expect(mimeFromExtension(".go")).toBe("text/x-go");
    expect(mimeFromExtension(".rs")).toBe("text/x-rust");
    expect(mimeFromExtension(".sh")).toBe("text/x-sh");
  });

  it("is case-insensitive", () => {
    expect(mimeFromExtension(".PNG")).toBe("image/png");
  });

  it("returns null for an unknown extension", () => {
    expect(mimeFromExtension(".notareal")).toBeNull();
  });

  it("returns null for the empty extension (directories)", () => {
    expect(mimeFromExtension("")).toBeNull();
  });
});

describe("isInlinePreviewable", () => {
  it("is true for image, video, audio, and text types", () => {
    expect(isInlinePreviewable("image/png")).toBe(true);
    expect(isInlinePreviewable("video/mp4")).toBe(true);
    expect(isInlinePreviewable("audio/mpeg")).toBe(true);
    expect(isInlinePreviewable("text/plain")).toBe(true);
  });

  it("is true for text/typescript and other text/* code mimes", () => {
    expect(isInlinePreviewable("text/typescript")).toBe(true);
    expect(isInlinePreviewable("text/x-sh")).toBe(true);
  });

  it("is true for application/pdf and application/json", () => {
    expect(isInlinePreviewable("application/pdf")).toBe(true);
    expect(isInlinePreviewable("application/json")).toBe(true);
  });

  it("is false for anything else", () => {
    expect(isInlinePreviewable("application/octet-stream")).toBe(false);
    expect(isInlinePreviewable("application/zip")).toBe(false);
  });
});
