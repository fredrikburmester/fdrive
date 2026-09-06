import type { FsEntry } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SORT_SPEC,
  readSortSpec,
  sortListing,
  toggleSortDirection,
  writeSortSpec,
} from "./sorting";
import type { StorageLike } from "./storage";

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function entry(overrides: Partial<FsEntry>): FsEntry {
  return {
    name: "a",
    path: "/a",
    kind: "file",
    size: 0,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
    ...overrides,
  };
}

describe("readSortSpec", () => {
  it("defaults to name/asc when nothing is stored", () => {
    expect(readSortSpec(memoryStorage())).toEqual(DEFAULT_SORT_SPEC);
  });

  it("returns a previously stored spec", () => {
    const storage = memoryStorage({
      "fdrive.sort": JSON.stringify({ key: "size", direction: "desc" }),
    });
    expect(readSortSpec(storage)).toEqual({ key: "size", direction: "desc" });
  });

  it("falls back to default for an unrecognized key", () => {
    const storage = memoryStorage({
      "fdrive.sort": JSON.stringify({ key: "bogus", direction: "asc" }),
    });
    expect(readSortSpec(storage)).toEqual(DEFAULT_SORT_SPEC);
  });

  it("falls back to default for an unrecognized direction", () => {
    const storage = memoryStorage({
      "fdrive.sort": JSON.stringify({ key: "name", direction: "sideways" }),
    });
    expect(readSortSpec(storage)).toEqual(DEFAULT_SORT_SPEC);
  });

  it("falls back to default when the stored value is not an object", () => {
    const storage = memoryStorage({ "fdrive.sort": JSON.stringify("name") });
    expect(readSortSpec(storage)).toEqual(DEFAULT_SORT_SPEC);
  });
});

describe("writeSortSpec", () => {
  it("persists the spec as JSON", () => {
    const storage = memoryStorage();
    writeSortSpec(storage, { key: "ext", direction: "desc" });
    expect(storage.getItem("fdrive.sort")).toBe(JSON.stringify({ key: "ext", direction: "desc" }));
  });
});

describe("toggleSortDirection", () => {
  it("flips asc to desc", () => {
    expect(toggleSortDirection({ key: "name", direction: "asc" })).toEqual({
      key: "name",
      direction: "desc",
    });
  });

  it("flips desc to asc", () => {
    expect(toggleSortDirection({ key: "size", direction: "desc" })).toEqual({
      key: "size",
      direction: "asc",
    });
  });
});

describe("sortListing", () => {
  it("puts folders first regardless of key", () => {
    const entries = [
      entry({ name: "b.txt", path: "/b.txt", kind: "file" }),
      entry({ name: "a-folder", path: "/a-folder", kind: "dir" }),
    ];
    const sorted = sortListing(entries, { key: "name", direction: "asc" });
    expect(sorted.map((e) => e.name)).toEqual(["a-folder", "b.txt"]);
  });

  it("sorts by the requested key and direction within each group", () => {
    const entries = [
      entry({ name: "a.txt", path: "/a.txt", size: 10 }),
      entry({ name: "b.txt", path: "/b.txt", size: 20 }),
    ];
    const sorted = sortListing(entries, { key: "size", direction: "desc" });
    expect(sorted.map((e) => e.name)).toEqual(["b.txt", "a.txt"]);
  });
});
