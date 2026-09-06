import type { FsEntry } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { siblingNavigation } from "./siblings";

function file(name: string, path: string): FsEntry {
  return {
    name,
    path,
    kind: "file",
    size: 10,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
  };
}

function dir(name: string, path: string): FsEntry {
  return {
    name,
    path,
    kind: "dir",
    size: 0,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
  };
}

describe("siblingNavigation", () => {
  const entries: FsEntry[] = [
    dir("Photos", "/Photos"),
    file("b.txt", "/b.txt"),
    file("a.txt", "/a.txt"),
    file("c.txt", "/c.txt"),
  ];

  it("excludes directories and sorts files by name", () => {
    const result = siblingNavigation(entries, "/a.txt");
    expect(result).toEqual({ prev: null, next: "/b.txt", index: 0, total: 3 });
  });

  it("finds prev and next around a middle entry", () => {
    const result = siblingNavigation(entries, "/b.txt");
    expect(result).toEqual({ prev: "/a.txt", next: "/c.txt", index: 1, total: 3 });
  });

  it("has no next at the last entry", () => {
    const result = siblingNavigation(entries, "/c.txt");
    expect(result).toEqual({ prev: "/b.txt", next: null, index: 2, total: 3 });
  });

  it("returns index -1 and null prev/next when currentPath is not present", () => {
    const result = siblingNavigation(entries, "/missing.txt");
    expect(result).toEqual({ prev: null, next: null, index: -1, total: 3 });
  });

  it("sorts numerically, matching the browser's natural order", () => {
    const numbered: FsEntry[] = [
      file("file10.txt", "/file10.txt"),
      file("file2.txt", "/file2.txt"),
    ];
    const result = siblingNavigation(numbered, "/file2.txt");
    expect(result).toEqual({ prev: null, next: "/file10.txt", index: 0, total: 2 });
  });

  it("handles a single previewable entry", () => {
    const result = siblingNavigation([file("only.txt", "/only.txt")], "/only.txt");
    expect(result).toEqual({ prev: null, next: null, index: 0, total: 1 });
  });

  it("handles an empty entry list", () => {
    const result = siblingNavigation([], "/anything.txt");
    expect(result).toEqual({ prev: null, next: null, index: -1, total: 0 });
  });
});
