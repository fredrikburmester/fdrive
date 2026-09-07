import { describe, expect, it } from "vitest";
import {
  allImageEntries,
  galleryEntries,
  type PresentationEntry,
  resolveEntriesPresentation,
  resolveSingleFilePresentation,
} from "./presentation";

const image = (name: string): PresentationEntry => ({ name, kind: "file" });
const dir = (name: string): PresentationEntry => ({ name, kind: "dir" });
const doc = (name: string): PresentationEntry => ({ name, kind: "file" });

describe("allImageEntries", () => {
  it("is false for an empty listing and true only when every entry is an image file", () => {
    expect(allImageEntries([])).toBe(false);
    expect(allImageEntries([image("a.png"), image("b.jpg")])).toBe(true);
    expect(allImageEntries([image("a.png"), doc("b.txt")])).toBe(false);
    expect(allImageEntries([image("a.png"), dir("sub")])).toBe(false);
  });
});

describe("resolveEntriesPresentation", () => {
  const images = [image("a.png"), image("b.jpg")];
  const mixed = [image("a.png"), doc("b.txt")];
  it("honours an explicit choice regardless of contents, except gallery without any image", () => {
    expect(resolveEntriesPresentation("download", images)).toBe("download");
    expect(resolveEntriesPresentation("list", images)).toBe("list");
    expect(resolveEntriesPresentation("gallery", images)).toBe("gallery");
    expect(resolveEntriesPresentation("gallery", mixed)).toBe("gallery");
    expect(resolveEntriesPresentation("gallery", [doc("b.txt")])).toBe("list");
    expect(resolveEntriesPresentation("gallery", [])).toBe("list");
  });
  it("auto resolves to gallery only when every entry is an image, otherwise list", () => {
    expect(resolveEntriesPresentation("auto", images)).toBe("gallery");
    expect(resolveEntriesPresentation("auto", mixed)).toBe("list");
    expect(resolveEntriesPresentation("auto", [dir("sub")])).toBe("list");
    expect(resolveEntriesPresentation("auto", [])).toBe("list");
  });
});

describe("galleryEntries", () => {
  it("keeps only the image files, dropping directories and non-image files", () => {
    expect(galleryEntries([image("a.png"), doc("b.txt"), dir("sub")])).toEqual([image("a.png")]);
    expect(galleryEntries([])).toEqual([]);
  });
});

describe("resolveSingleFilePresentation", () => {
  it("shows a one-image gallery for auto or gallery on an image file, download otherwise", () => {
    expect(resolveSingleFilePresentation("auto", "photo.png")).toBe("gallery");
    expect(resolveSingleFilePresentation("gallery", "photo.png")).toBe("gallery");
    expect(resolveSingleFilePresentation("auto", "report.pdf")).toBe("download");
    expect(resolveSingleFilePresentation("gallery", "report.pdf")).toBe("download");
    expect(resolveSingleFilePresentation("list", "photo.png")).toBe("download");
    expect(resolveSingleFilePresentation("download", "photo.png")).toBe("download");
    expect(resolveSingleFilePresentation("auto", null)).toBe("download");
  });
});

describe("download-limited shares", () => {
  const images = [
    { name: "a.jpg", kind: "file" as const },
    { name: "b.png", kind: "file" as const },
  ];
  it("never resolves a listing to gallery when the link has a download limit", () => {
    expect(resolveEntriesPresentation("auto", images, { downloadLimited: true })).toBe("list");
    expect(resolveEntriesPresentation("gallery", images, { downloadLimited: true })).toBe("list");
    expect(resolveEntriesPresentation("download", images, { downloadLimited: true })).toBe(
      "download",
    );
    expect(resolveEntriesPresentation("auto", images, { downloadLimited: false })).toBe("gallery");
  });
  it("shows the download card instead of a one-image gallery for a limited single file", () => {
    expect(resolveSingleFilePresentation("auto", "a.jpg", { downloadLimited: true })).toBe(
      "download",
    );
    expect(resolveSingleFilePresentation("gallery", "a.jpg", { downloadLimited: false })).toBe(
      "gallery",
    );
  });
});
