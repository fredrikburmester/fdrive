import { describe, expect, it } from "vitest";
import { languageFor, previewKindFor, previewUnavailableReason, TEXT_LIMIT_BYTES } from "./kind";

function entry(ext: string, mime: string | null, size = 1024) {
  return { ext, mime, size };
}

describe("previewKindFor", () => {
  it("detects images by extension", () => {
    expect(previewKindFor(entry(".png", null))).toBe("image");
    expect(previewKindFor(entry(".svg", null))).toBe("image");
  });

  it("detects images by mime when the extension is unknown", () => {
    expect(previewKindFor(entry(".weird", "image/png"))).toBe("image");
  });

  it("detects video", () => {
    expect(previewKindFor(entry(".mp4", null))).toBe("video");
    expect(previewKindFor(entry(".weird", "video/mp4"))).toBe("video");
  });

  it("detects audio", () => {
    expect(previewKindFor(entry(".mp3", null))).toBe("audio");
    expect(previewKindFor(entry(".weird", "audio/mpeg"))).toBe("audio");
  });

  it("detects pdf by extension or mime", () => {
    expect(previewKindFor(entry(".pdf", null))).toBe("pdf");
    expect(previewKindFor(entry(".weird", "application/pdf"))).toBe("pdf");
  });

  it("detects markdown", () => {
    expect(previewKindFor(entry(".md", null))).toBe("markdown");
    expect(previewKindFor(entry(".mdx", null))).toBe("markdown");
  });

  it("detects code by extension", () => {
    expect(previewKindFor(entry(".ts", null))).toBe("code");
    expect(previewKindFor(entry(".py", null))).toBe("code");
  });

  it("detects office documents", () => {
    expect(previewKindFor(entry(".docx", null))).toBe("office");
    expect(previewKindFor(entry(".xlsx", null))).toBe("office");
  });

  it("detects archives, including compound extensions", () => {
    expect(previewKindFor(entry(".zip", null))).toBe("archive");
    expect(previewKindFor(entry(".tar.gz", null))).toBe("archive");
  });

  it("detects plain text by extension or mime", () => {
    expect(previewKindFor(entry(".txt", null))).toBe("text");
    expect(previewKindFor(entry(".weird", "text/plain"))).toBe("text");
  });

  it("returns 'none' for an unrecognized extension and mime", () => {
    expect(previewKindFor(entry(".bin", null))).toBe("none");
  });

  it("is case-insensitive on extension", () => {
    expect(previewKindFor(entry(".PNG", null))).toBe("image");
  });

  it("allows text at exactly the size limit", () => {
    expect(previewKindFor(entry(".txt", null, TEXT_LIMIT_BYTES))).toBe("text");
  });

  it("falls back to 'none' for text-like kinds over the size limit", () => {
    expect(previewKindFor(entry(".txt", null, TEXT_LIMIT_BYTES + 1))).toBe("none");
    expect(previewKindFor(entry(".md", null, TEXT_LIMIT_BYTES + 1))).toBe("none");
    expect(previewKindFor(entry(".ts", null, TEXT_LIMIT_BYTES + 1))).toBe("none");
  });

  it("does not cap non-text kinds by size", () => {
    expect(previewKindFor(entry(".png", null, TEXT_LIMIT_BYTES * 10))).toBe("image");
  });
});

describe("previewUnavailableReason", () => {
  it("returns null when the entry is previewable", () => {
    expect(previewUnavailableReason(entry(".png", null))).toBeNull();
  });

  it("explains the size cap for oversized text-like files", () => {
    expect(previewUnavailableReason(entry(".txt", null, TEXT_LIMIT_BYTES + 1))).toMatch(/2 MiB/);
  });

  it("gives a generic reason for unsupported file types", () => {
    expect(previewUnavailableReason(entry(".bin", null))).toMatch(/built-in preview/);
  });
});

describe("languageFor", () => {
  it("maps known extensions to a language identifier", () => {
    expect(languageFor(".ts")).toBe("typescript");
    expect(languageFor(".py")).toBe("python");
    expect(languageFor(".rs")).toBe("rust");
  });

  it("is case-insensitive", () => {
    expect(languageFor(".TS")).toBe("typescript");
  });

  it("falls back to 'plaintext' for an unknown extension", () => {
    expect(languageFor(".zzz")).toBe("plaintext");
  });
});
