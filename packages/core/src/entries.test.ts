import { describe, expect, it } from "vitest";
import { type FileEntry, makeEntry, sortEntries } from "./entries.js";

describe("makeEntry", () => {
  it("fills path by joining parentPath and name", () => {
    const entry = makeEntry("/docs", {
      name: "report.pdf",
      kind: "file",
      size: 1024,
      modifiedAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(entry.path).toBe("/docs/report.pdf");
    expect(entry.name).toBe("report.pdf");
    expect(entry.size).toBe(1024);
  });

  it("fills ext from the name for a file", () => {
    const entry = makeEntry("/docs", {
      name: "report.PDF",
      kind: "file",
      size: 1,
      modifiedAt: new Date(),
    });

    expect(entry.ext).toBe(".pdf");
  });

  it("gives directories an empty ext even if the name has a dot", () => {
    const entry = makeEntry("/", {
      name: "archive.old",
      kind: "dir",
      size: 0,
      modifiedAt: new Date(),
    });

    expect(entry.ext).toBe("");
  });

  it("normalizes the parent path", () => {
    const entry = makeEntry("/a//b/", {
      name: "x.txt",
      kind: "file",
      size: 0,
      modifiedAt: new Date(),
    });

    expect(entry.path).toBe("/a/b/x.txt");
  });
});

function entry(overrides: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    path: `/${overrides.name}`,
    kind: "file",
    size: 0,
    modifiedAt: new Date(0),
    ext: "",
    ...overrides,
  };
}

describe("sortEntries", () => {
  it("sorts by name in natural order (numeric-aware, case-insensitive)", () => {
    const entries = [
      entry({ name: "img10.png" }),
      entry({ name: "img2.png" }),
      entry({ name: "IMG1.png" }),
    ];

    const sorted = sortEntries(entries, { key: "name", direction: "asc" });

    expect(sorted.map((e) => e.name)).toEqual(["IMG1.png", "img2.png", "img10.png"]);
  });

  it("sorts descending", () => {
    const entries = [entry({ name: "a" }), entry({ name: "b" }), entry({ name: "c" })];

    const sorted = sortEntries(entries, { key: "name", direction: "desc" });

    expect(sorted.map((e) => e.name)).toEqual(["c", "b", "a"]);
  });

  it("sorts by size", () => {
    const entries = [
      entry({ name: "big", size: 300 }),
      entry({ name: "small", size: 1 }),
      entry({ name: "mid", size: 50 }),
    ];

    const sorted = sortEntries(entries, { key: "size", direction: "asc" });

    expect(sorted.map((e) => e.name)).toEqual(["small", "mid", "big"]);
  });

  it("sorts by modifiedAt", () => {
    const entries = [
      entry({ name: "newest", modifiedAt: new Date("2026-03-01") }),
      entry({ name: "oldest", modifiedAt: new Date("2026-01-01") }),
      entry({ name: "middle", modifiedAt: new Date("2026-02-01") }),
    ];

    const sorted = sortEntries(entries, { key: "modifiedAt", direction: "asc" });

    expect(sorted.map((e) => e.name)).toEqual(["oldest", "middle", "newest"]);
  });

  it("sorts by ext", () => {
    const entries = [
      entry({ name: "a.zip", ext: ".zip" }),
      entry({ name: "b.avi", ext: ".avi" }),
      entry({ name: "c.mp4", ext: ".mp4" }),
    ];

    const sorted = sortEntries(entries, { key: "ext", direction: "asc" });

    expect(sorted.map((e) => e.name)).toEqual(["b.avi", "c.mp4", "a.zip"]);
  });

  it("is stable for equal keys", () => {
    const entries = [
      entry({ name: "first", size: 5 }),
      entry({ name: "second", size: 5 }),
      entry({ name: "third", size: 5 }),
    ];

    const sorted = sortEntries(entries, { key: "size", direction: "asc" });

    expect(sorted.map((e) => e.name)).toEqual(["first", "second", "third"]);
  });

  it("puts folders first when foldersFirst is set, regardless of key", () => {
    const entries = [
      entry({ name: "z-file", kind: "file" }),
      entry({ name: "b-dir", kind: "dir" }),
      entry({ name: "a-file", kind: "file" }),
      entry({ name: "y-dir", kind: "dir" }),
    ];

    const sorted = sortEntries(entries, { key: "name", direction: "asc", foldersFirst: true });

    expect(sorted.map((e) => e.name)).toEqual(["b-dir", "y-dir", "a-file", "z-file"]);
  });

  it("defaults foldersFirst to false", () => {
    const entries = [entry({ name: "b", kind: "dir" }), entry({ name: "a", kind: "file" })];

    const sorted = sortEntries(entries, { key: "name", direction: "asc" });

    expect(sorted.map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("accepts a custom collator", () => {
    const entries = [entry({ name: "b" }), entry({ name: "a" })];
    const reverseCollator = {
      compare: (a: string, b: string) => b.localeCompare(a),
    } as Intl.Collator;

    const sorted = sortEntries(entries, {
      key: "name",
      direction: "asc",
      collator: reverseCollator,
    });

    expect(sorted.map((e) => e.name)).toEqual(["b", "a"]);
  });

  it("returns a new array and does not mutate the input", () => {
    const entries = [entry({ name: "b" }), entry({ name: "a" })];
    const sorted = sortEntries(entries, { key: "name", direction: "asc" });

    expect(sorted).not.toBe(entries);
    expect(entries.map((e) => e.name)).toEqual(["b", "a"]);
  });

  it("returns an empty array unchanged", () => {
    expect(sortEntries([], { key: "name", direction: "asc" })).toEqual([]);
  });
});
