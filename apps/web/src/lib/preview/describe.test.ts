import type { FsEntry } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { describeEntry, kindLabel, relativeTimeFrom } from "./describe";

const NOW = new Date("2024-06-15T14:30:00.000Z");

function entry(overrides: Partial<FsEntry> = {}): FsEntry {
  return {
    name: "report.pdf",
    path: "/docs/report.pdf",
    kind: "file",
    size: 2048,
    modifiedAt: "2024-06-14T09:00:00.000Z",
    ext: ".pdf",
    mime: null,
    ...overrides,
  };
}

describe("kindLabel", () => {
  it("labels a folder", () => {
    expect(kindLabel({ kind: "dir", ext: "", mime: null, size: 0 })).toBe("Folder");
  });

  it("labels a symlink", () => {
    expect(kindLabel({ kind: "symlink", ext: "", mime: null, size: 0 })).toBe("Symlink");
  });

  it("labels an 'other' entry as File", () => {
    expect(kindLabel({ kind: "other", ext: "", mime: null, size: 0 })).toBe("File");
  });

  it("labels a pdf file", () => {
    expect(kindLabel({ kind: "file", ext: ".pdf", mime: null, size: 100 })).toBe("PDF Document");
  });

  it("falls back to File for an unrecognized file type", () => {
    expect(kindLabel({ kind: "file", ext: ".bin", mime: null, size: 100 })).toBe("File");
  });
});

describe("relativeTimeFrom", () => {
  it("returns 'just now' for differences under a minute", () => {
    const date = new Date(NOW.getTime() - 30_000);
    expect(relativeTimeFrom(date, NOW)).toBe("just now");
  });

  it("formats minutes ago", () => {
    const date = new Date(NOW.getTime() - 5 * 60_000);
    expect(relativeTimeFrom(date, NOW)).toMatch(/5 minutes ago/);
  });

  it("formats hours ago", () => {
    const date = new Date(NOW.getTime() - 3 * 60 * 60_000);
    expect(relativeTimeFrom(date, NOW)).toMatch(/3 hours ago/);
  });

  it("formats days ago", () => {
    const date = new Date(NOW.getTime() - 2 * 24 * 60 * 60_000);
    expect(relativeTimeFrom(date, NOW)).toMatch(/2 days ago/);
  });

  it("formats weeks ago", () => {
    const date = new Date(NOW.getTime() - 2 * 7 * 24 * 60 * 60_000);
    expect(relativeTimeFrom(date, NOW)).toMatch(/2 weeks ago/);
  });

  it("formats months ago", () => {
    const date = new Date(NOW.getTime() - 2 * 30 * 24 * 60 * 60_000);
    expect(relativeTimeFrom(date, NOW)).toMatch(/2 months ago/);
  });

  it("formats years ago", () => {
    const date = new Date(NOW.getTime() - 2 * 365 * 24 * 60 * 60_000);
    expect(relativeTimeFrom(date, NOW)).toMatch(/2 years ago/);
  });

  it("formats a future date", () => {
    const date = new Date(NOW.getTime() + 5 * 60_000);
    expect(relativeTimeFrom(date, NOW)).toMatch(/in 5 minutes/);
  });
});

describe("describeEntry", () => {
  it("produces Kind, Size, Modified, Location, and Extension rows", () => {
    const result = describeEntry(entry(), { now: NOW });
    expect(result.rows.map((row) => row.label)).toEqual([
      "Kind",
      "Size",
      "Modified",
      "Location",
      "Extension",
    ]);
    expect(result.rows[0]?.value).toBe("PDF Document");
    expect(result.rows[1]?.value).toBe("2.0 KB");
    expect(result.rows[3]?.value).toBe("/docs");
  });

  it("combines an absolute and a relative timestamp in Modified", () => {
    const result = describeEntry(entry(), { now: NOW });
    const modified = result.rows.find((row) => row.label === "Modified");
    expect(modified?.value).toMatch(/^.+ \(.+\)$/);
    expect(modified?.value).toContain("yesterday");
  });

  it("shows an em dash for an entry with no extension", () => {
    const result = describeEntry(entry({ ext: "", name: "README" }), { now: NOW });
    const extension = result.rows.find((row) => row.label === "Extension");
    expect(extension?.value).toBe("—");
  });

  it("shows the root as the location for a top-level entry", () => {
    const result = describeEntry(entry({ path: "/report.pdf" }), { now: NOW });
    const location = result.rows.find((row) => row.label === "Location");
    expect(location?.value).toBe("/");
  });

  it("respects a given locale", () => {
    const result = describeEntry(entry(), { now: NOW, locale: "de-DE" });
    const size = result.rows.find((row) => row.label === "Size");
    expect(size?.value).toBe("2,0 KB");
  });

  it("returns a null note for a plain file", () => {
    const result = describeEntry(entry(), { now: NOW });
    expect(result.note).toBeNull();
  });

  it("ignores folderSize for a file entry", () => {
    const result = describeEntry(entry(), {
      now: NOW,
      folderSize: { isPending: false, isError: false, data: { bytes: 1, files: 1, indexed: true } },
    });
    expect(result.rows.map((row) => row.label)).not.toContain("Files");
    expect(result.rows.find((row) => row.label === "Size")?.value).toBe("2.0 KB");
  });

  it("shows Calculating for a directory while the folder size query is pending", () => {
    const dirEntry = entry({ kind: "dir", name: "photos", path: "/photos", ext: "", size: 0 });
    const result = describeEntry(dirEntry, {
      now: NOW,
      folderSize: { isPending: true, isError: false },
    });
    expect(result.rows.find((row) => row.label === "Size")?.value).toBe("Calculating");
    expect(result.rows.find((row) => row.label === "Files")?.value).toBe("Calculating");
    expect(result.note).toBeNull();
  });

  it("shows Not indexed for a directory the folder size query errors on", () => {
    const dirEntry = entry({ kind: "dir", name: "photos", path: "/photos", ext: "", size: 0 });
    const result = describeEntry(dirEntry, {
      now: NOW,
      folderSize: { isPending: false, isError: true },
    });
    expect(result.rows.find((row) => row.label === "Size")?.value).toBe("Not indexed");
    expect(result.rows.find((row) => row.label === "Files")?.value).toBe("Not indexed");
  });

  it("shows Not indexed for a directory outside the index", () => {
    const dirEntry = entry({ kind: "dir", name: "photos", path: "/photos", ext: "", size: 0 });
    const result = describeEntry(dirEntry, {
      now: NOW,
      folderSize: {
        isPending: false,
        isError: false,
        data: { bytes: 0, files: 0, indexed: false },
      },
    });
    expect(result.rows.find((row) => row.label === "Size")?.value).toBe("Not indexed");
    expect(result.rows.find((row) => row.label === "Files")?.value).toBe("Not indexed");
  });

  it("shows the real byte and file counts for an indexed directory, with a note", () => {
    const dirEntry = entry({ kind: "dir", name: "photos", path: "/photos", ext: "", size: 0 });
    const result = describeEntry(dirEntry, {
      now: NOW,
      folderSize: {
        isPending: false,
        isError: false,
        data: { bytes: 2048, files: 12, indexed: true },
      },
    });
    expect(result.rows.find((row) => row.label === "Size")?.value).toBe("2.0 KB");
    expect(result.rows.find((row) => row.label === "Files")?.value).toBe("12");
    expect(result.note).toBe("From the index");
  });

  it("inserts the Files row right after Size for a directory", () => {
    const dirEntry = entry({ kind: "dir", name: "photos", path: "/photos", ext: "", size: 0 });
    const result = describeEntry(dirEntry, {
      now: NOW,
      folderSize: {
        isPending: false,
        isError: false,
        data: { bytes: 2048, files: 12, indexed: true },
      },
    });
    expect(result.rows.map((row) => row.label)).toEqual([
      "Kind",
      "Size",
      "Files",
      "Modified",
      "Location",
      "Extension",
    ]);
  });
});
