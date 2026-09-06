import type { FsEntry } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_SORT_SPEC } from "./sorting";
import { flattenTree, reachableExpandedDirs } from "./tree-rows";

function entry(overrides: Partial<FsEntry> & Pick<FsEntry, "path" | "kind">): FsEntry {
  return {
    name: overrides.path.split("/").at(-1) ?? overrides.path,
    size: 0,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
    ...overrides,
  };
}

const dirA = entry({ path: "/a", kind: "dir" });
const fileB = entry({ path: "/b.txt", kind: "file" });
const dirAX = entry({ path: "/a/x", kind: "dir" });
const fileAY = entry({ path: "/a/y.txt", kind: "file" });

describe("flattenTree", () => {
  it("lists the sorted root entries at depth 0 when nothing is expanded", () => {
    const rows = flattenTree([fileB, dirA], new Set(), new Map(), DEFAULT_SORT_SPEC);
    expect(rows).toEqual([
      { entry: dirA, depth: 0 },
      { entry: fileB, depth: 0 },
    ]);
  });

  it("descends into an expanded, loaded directory", () => {
    const childrenByPath = new Map<string, readonly FsEntry[]>([["/a", [fileAY, dirAX]]]);
    const rows = flattenTree([dirA, fileB], new Set(["/a"]), childrenByPath, DEFAULT_SORT_SPEC);
    expect(rows).toEqual([
      { entry: dirA, depth: 0 },
      { entry: dirAX, depth: 1 },
      { entry: fileAY, depth: 1 },
      { entry: fileB, depth: 0 },
    ]);
  });

  it("does not descend into a file even if its path is expanded", () => {
    const childrenByPath = new Map<string, readonly FsEntry[]>([["/b.txt", [dirA]]]);
    const rows = flattenTree([fileB], new Set(["/b.txt"]), childrenByPath, DEFAULT_SORT_SPEC);
    expect(rows).toEqual([{ entry: fileB, depth: 0 }]);
  });

  it("does not descend into an expanded directory with no loaded children yet", () => {
    const rows = flattenTree([dirA], new Set(["/a"]), new Map(), DEFAULT_SORT_SPEC);
    expect(rows).toEqual([{ entry: dirA, depth: 0 }]);
  });

  it("recurses multiple levels deep", () => {
    const dirAXZ = entry({ path: "/a/x/z", kind: "dir" });
    const childrenByPath = new Map<string, readonly FsEntry[]>([
      ["/a", [dirAX]],
      ["/a/x", [dirAXZ]],
    ]);
    const rows = flattenTree([dirA], new Set(["/a", "/a/x"]), childrenByPath, DEFAULT_SORT_SPEC);
    expect(rows).toEqual([
      { entry: dirA, depth: 0 },
      { entry: dirAX, depth: 1 },
      { entry: dirAXZ, depth: 2 },
    ]);
  });
});

describe("reachableExpandedDirs", () => {
  it("is empty when nothing is expanded", () => {
    expect(reachableExpandedDirs([dirA, fileB], new Set(), new Map())).toEqual([]);
  });

  it("includes an expanded root-level directory", () => {
    expect(reachableExpandedDirs([dirA, fileB], new Set(["/a"]), new Map())).toEqual(["/a"]);
  });

  it("ignores an expanded path that is a file, not a directory", () => {
    expect(reachableExpandedDirs([fileB], new Set(["/b.txt"]), new Map())).toEqual([]);
  });

  it("descends into loaded children to find nested expanded directories", () => {
    const dirAXZ = entry({ path: "/a/x/z", kind: "dir" });
    const childrenByPath = new Map<string, readonly FsEntry[]>([
      ["/a", [dirAX]],
      ["/a/x", [dirAXZ]],
    ]);
    expect(reachableExpandedDirs([dirA], new Set(["/a", "/a/x"]), childrenByPath)).toEqual([
      "/a",
      "/a/x",
    ]);
  });

  it("stops descending once it reaches a directory not yet loaded", () => {
    expect(reachableExpandedDirs([dirA], new Set(["/a", "/a/x"]), new Map())).toEqual(["/a"]);
  });
});
