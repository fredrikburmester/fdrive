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
    expect(mimeFromExtension(".ts")).toBe("video/mp2t");
    expect(mimeFromExtension(".docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
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

  it("is true for application/pdf and application/json", () => {
    expect(isInlinePreviewable("application/pdf")).toBe(true);
    expect(isInlinePreviewable("application/json")).toBe(true);
  });

  it("is false for anything else", () => {
    expect(isInlinePreviewable("application/octet-stream")).toBe(false);
    expect(isInlinePreviewable("application/zip")).toBe(false);
  });
});
