import type { ArchiveEntry } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  archiveEntryFolder,
  filterArchiveEntries,
  groupArchiveEntries,
  matchesArchiveSearch,
} from "./grouping";

function entry(path: string, kind: "file" | "dir" = "file"): ArchiveEntry {
  return { path, kind, size: 1, modifiedAt: null };
}

describe("archiveEntryFolder", () => {
  it("returns the root for a top-level entry", () => {
    expect(archiveEntryFolder("a.txt")).toBe("");
  });

  it("returns the immediate parent for a nested entry", () => {
    expect(archiveEntryFolder("dir/sub/file.txt")).toBe("dir/sub");
  });

  it("returns the folder itself for a directory entry", () => {
    expect(archiveEntryFolder("dir/sub")).toBe("dir");
  });
});

describe("matchesArchiveSearch", () => {
  it("matches a case-insensitive substring anywhere in the path", () => {
    expect(matchesArchiveSearch(entry("dir/Report.PDF"), "report")).toBe(true);
  });

  it("does not match an unrelated query", () => {
    expect(matchesArchiveSearch(entry("dir/report.pdf"), "invoice")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(matchesArchiveSearch(entry("dir/report.pdf"), "")).toBe(true);
  });

  it("matches everything for a whitespace-only query", () => {
    expect(matchesArchiveSearch(entry("dir/report.pdf"), "   ")).toBe(true);
  });
});

describe("filterArchiveEntries", () => {
  it("keeps only entries matching the query", () => {
    const entries = [entry("a.txt"), entry("b.txt"), entry("dir/a-nested.txt")];
    expect(filterArchiveEntries(entries, "a")).toEqual([entries[0], entries[2]]);
  });

  it("returns every entry for an empty query", () => {
    const entries = [entry("a.txt"), entry("b.txt")];
    expect(filterArchiveEntries(entries, "")).toEqual(entries);
  });
});

describe("groupArchiveEntries", () => {
  it("groups root-level entries under the empty folder key", () => {
    const entries = [entry("a.txt"), entry("b.txt")];
    expect(groupArchiveEntries(entries)).toEqual([{ folder: "", entries }]);
  });

  it("groups nested entries by their immediate parent folder", () => {
    const a = entry("a.txt");
    const nested1 = entry("dir/one.txt");
    const nested2 = entry("dir/two.txt");
    const deepNested = entry("dir/sub/three.txt");

    expect(groupArchiveEntries([a, nested1, deepNested, nested2])).toEqual([
      { folder: "", entries: [a] },
      { folder: "dir", entries: [nested1, nested2] },
      { folder: "dir/sub", entries: [deepNested] },
    ]);
  });

  it("sorts the root folder first even when it is not encountered first", () => {
    const nested = entry("dir/one.txt");
    const root = entry("a.txt");

    expect(groupArchiveEntries([nested, root]).map((g) => g.folder)).toEqual(["", "dir"]);
  });

  it("sorts non-root folders lexicographically", () => {
    const entries = [entry("z/one.txt"), entry("a/two.txt")];
    expect(groupArchiveEntries(entries).map((g) => g.folder)).toEqual(["a", "z"]);
  });

  it("returns no groups for an empty entry list", () => {
    expect(groupArchiveEntries([])).toEqual([]);
  });
});
