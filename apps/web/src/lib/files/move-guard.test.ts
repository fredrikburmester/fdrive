import { describe, expect, it } from "vitest";
import { canMoveInto, movablePaths } from "./move-guard";

describe("canMoveInto", () => {
  it("is false when the target is the source's current parent", () => {
    expect(canMoveInto("/a/b", "/a")).toBe(false);
  });

  it("is false when moving a folder into itself", () => {
    expect(canMoveInto("/a/b", "/a/b")).toBe(false);
  });

  it("is false when moving a folder into its own descendant", () => {
    expect(canMoveInto("/a", "/a/b/c")).toBe(false);
  });

  it("is true for a valid move into an unrelated folder", () => {
    expect(canMoveInto("/a/b", "/c")).toBe(true);
  });

  it("is true for a valid move to a different depth", () => {
    expect(canMoveInto("/a/b/c", "/x")).toBe(true);
  });
});

describe("movablePaths", () => {
  it("filters out invalid moves, keeping valid ones", () => {
    expect(movablePaths(["/a/b", "/c", "/x/y"], "/a")).toEqual(["/c", "/x/y"]);
  });

  it("returns an empty array when nothing is movable", () => {
    expect(movablePaths(["/a"], "/a/b")).toEqual([]);
  });
});
