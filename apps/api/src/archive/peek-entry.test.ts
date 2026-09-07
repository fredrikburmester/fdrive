import { describe, expect, it } from "vitest";
import {
  boundPeekEntries,
  buildPeekEntry,
  comparePeekEntryPath,
  displayArchiveEntryPath,
  isUnsafeArchiveEntryName,
  type PeekEntry,
  sortPeekEntries,
} from "./peek-entry.js";

describe("isUnsafeArchiveEntryName", () => {
  it("accepts an ordinary relative name", () => {
    expect(isUnsafeArchiveEntryName("dir/file.txt")).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(isUnsafeArchiveEntryName("")).toBe(true);
  });

  it("rejects a POSIX absolute path", () => {
    expect(isUnsafeArchiveEntryName("/etc/passwd")).toBe(true);
  });

  it("rejects a Windows drive-rooted path", () => {
    expect(isUnsafeArchiveEntryName("C:/Windows/system.ini")).toBe(true);
  });

  it("rejects a backslash-rooted path once normalized", () => {
    expect(isUnsafeArchiveEntryName("C:\\Windows\\system.ini")).toBe(true);
  });

  it("rejects a name with a .. segment", () => {
    expect(isUnsafeArchiveEntryName("../evil.txt")).toBe(true);
  });

  it("rejects a name with a .. segment in the middle", () => {
    expect(isUnsafeArchiveEntryName("dir/../../evil.txt")).toBe(true);
  });

  it("does not treat a name merely containing '..' as a whole word as unsafe", () => {
    expect(isUnsafeArchiveEntryName("dir/file..txt")).toBe(false);
  });
});

describe("displayArchiveEntryPath", () => {
  it("normalizes backslashes to forward slashes", () => {
    expect(displayArchiveEntryPath("dir\\file.txt")).toBe("dir/file.txt");
  });

  it("strips a single trailing slash", () => {
    expect(displayArchiveEntryPath("dir/")).toBe("dir");
  });

  it("leaves a name without a trailing slash unchanged", () => {
    expect(displayArchiveEntryPath("dir/file.txt")).toBe("dir/file.txt");
  });
});

describe("buildPeekEntry", () => {
  const MODIFIED_AT = new Date("2026-01-01T00:00:00.000Z");

  it("builds a file entry", () => {
    expect(buildPeekEntry("dir/file.txt", false, 42, MODIFIED_AT)).toEqual({
      path: "dir/file.txt",
      kind: "file",
      size: 42,
      modifiedAt: MODIFIED_AT,
    });
  });

  it("builds a directory entry, stripping its trailing slash", () => {
    expect(buildPeekEntry("dir/", true, 0, MODIFIED_AT)).toEqual({
      path: "dir",
      kind: "dir",
      size: 0,
      modifiedAt: MODIFIED_AT,
    });
  });

  it("forces kind file for an unsafe name even with a directory hint", () => {
    expect(buildPeekEntry("../evil/", true, 0, null)).toEqual({
      path: "../evil",
      kind: "file",
      size: 0,
      modifiedAt: null,
    });
  });

  it("accepts a null modifiedAt", () => {
    expect(buildPeekEntry("a.txt", false, 1, null).modifiedAt).toBeNull();
  });
});

describe("comparePeekEntryPath", () => {
  function entry(path: string): PeekEntry {
    return { path, kind: "file", size: 0, modifiedAt: null };
  }

  it("orders a before b when a's path sorts first", () => {
    expect(comparePeekEntryPath(entry("a"), entry("b"))).toBe(-1);
  });

  it("orders b before a when a's path sorts after", () => {
    expect(comparePeekEntryPath(entry("b"), entry("a"))).toBe(1);
  });

  it("treats equal paths as equal", () => {
    expect(comparePeekEntryPath(entry("a"), entry("a"))).toBe(0);
  });
});

describe("sortPeekEntries", () => {
  it("sorts entries by path, without mutating the input array", () => {
    const original: PeekEntry[] = [
      { path: "c", kind: "file", size: 0, modifiedAt: null },
      { path: "a", kind: "file", size: 0, modifiedAt: null },
      { path: "b", kind: "file", size: 0, modifiedAt: null },
    ];
    const sorted = sortPeekEntries(original);

    expect(sorted.map((e) => e.path)).toEqual(["a", "b", "c"]);
    expect(original.map((e) => e.path)).toEqual(["c", "a", "b"]);
  });
});

describe("boundPeekEntries", () => {
  function entries(count: number): PeekEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      path: `entry-${i}`,
      kind: "file" as const,
      size: 0,
      modifiedAt: null,
    }));
  }

  it("reports no truncation when entries fit within the bound", () => {
    const result = boundPeekEntries(entries(3), 5);
    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(3);
  });

  it("reports no truncation when entries exactly match the bound", () => {
    const result = boundPeekEntries(entries(5), 5);
    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(5);
  });

  it("truncates and reports it when entries exceed the bound", () => {
    const result = boundPeekEntries(entries(6), 5);
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(5);
    expect(result.entries.map((e) => e.path)).toEqual([
      "entry-0",
      "entry-1",
      "entry-2",
      "entry-3",
      "entry-4",
    ]);
  });
});
