import type { FsEntry } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { applyFavoriteToEntries, applyTagsToEntries, tagCheckState, toggleTagId } from "./tag-set";

function entry(path: string, overrides: Partial<FsEntry> = {}): FsEntry {
  return {
    name: path.split("/").at(-1) ?? path,
    path,
    kind: "file",
    size: 0,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
    ...overrides,
  };
}

describe("toggleTagId", () => {
  it("adds a tag that is not present when checked is true", () => {
    expect(toggleTagId(["a"], "b", true)).toEqual(["a", "b"]);
  });

  it("removes a tag that is present when checked is false", () => {
    expect(toggleTagId(["a", "b"], "b", false)).toEqual(["a"]);
  });

  it("is a no-op (new array, same contents) when already checked", () => {
    const result = toggleTagId(["a"], "a", true);
    expect(result).toEqual(["a"]);
  });

  it("is a no-op (new array, same contents) when already unchecked", () => {
    const result = toggleTagId(["a"], "b", false);
    expect(result).toEqual(["a"]);
  });
});

describe("tagCheckState", () => {
  it("is unchecked for an empty selection", () => {
    expect(tagCheckState([], "t1")).toBe("unchecked");
  });

  it("is checked when every entry has the tag", () => {
    expect(tagCheckState([{ tagIds: ["t1"] }, { tagIds: ["t1", "t2"] }], "t1")).toBe("checked");
  });

  it("is unchecked when no entry has the tag", () => {
    expect(tagCheckState([{ tagIds: ["t2"] }, { tagIds: [] }], "t1")).toBe("unchecked");
  });

  it("is indeterminate when some but not all entries have the tag", () => {
    expect(tagCheckState([{ tagIds: ["t1"] }, { tagIds: [] }], "t1")).toBe("indeterminate");
  });
});

describe("applyTagsToEntries", () => {
  it("replaces the matching entry's meta.tagIds, keeping favorite unchanged", () => {
    const entries = [entry("/a", { meta: { tagIds: ["t1"], favorite: true } }), entry("/b")];
    const result = applyTagsToEntries(entries, "/a", ["t2", "t3"]);
    expect(result[0]?.meta).toEqual({ tagIds: ["t2", "t3"], favorite: true });
    expect(result[1]).toBe(entries[1]);
  });

  it("defaults favorite to false when the entry had no meta", () => {
    const entries = [entry("/a")];
    const result = applyTagsToEntries(entries, "/a", ["t1"]);
    expect(result[0]?.meta).toEqual({ tagIds: ["t1"], favorite: false });
  });

  it("returns an equivalent array unchanged when the path is not present", () => {
    const entries = [entry("/a")];
    const result = applyTagsToEntries(entries, "/nope", ["t1"]);
    expect(result).toEqual(entries);
    expect(result).not.toBe(entries);
  });
});

describe("applyFavoriteToEntries", () => {
  it("sets favorite on the matching entry, keeping tags unchanged", () => {
    const entries = [entry("/a", { meta: { tagIds: ["t1"], favorite: false } })];
    const result = applyFavoriteToEntries(entries, "/a", true);
    expect(result[0]?.meta).toEqual({ tagIds: ["t1"], favorite: true });
  });

  it("defaults tagIds to empty when the entry had no meta", () => {
    const entries = [entry("/a")];
    const result = applyFavoriteToEntries(entries, "/a", true);
    expect(result[0]?.meta).toEqual({ tagIds: [], favorite: true });
  });

  it("returns an equivalent array unchanged when the path is not present", () => {
    const entries = [entry("/a")];
    const result = applyFavoriteToEntries(entries, "/nope", true);
    expect(result).toEqual(entries);
    expect(result).not.toBe(entries);
  });
});
