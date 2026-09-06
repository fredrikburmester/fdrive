import { describe, expect, it } from "vitest";
import { hasAction, hasAnyAction, resolvePermissions } from "./permissions.js";

describe("resolvePermissions", () => {
  it("returns no permissions when nothing matches", () => {
    expect(resolvePermissions({ "/a": ["list"] }, "/b")).toEqual([]);
  });

  it("matches the root as a fallback for any path", () => {
    expect(resolvePermissions({ "/": ["list"] }, "/a/b")).toEqual(["list"]);
  });

  it("picks the longest matching prefix", () => {
    const permissions = {
      "/": ["list"],
      "/a": ["download"],
      "/a/b": ["upload"],
    };
    expect(resolvePermissions(permissions, "/a/b/c.txt")).toEqual(["upload"]);
    expect(resolvePermissions(permissions, "/a/other.txt")).toEqual(["download"]);
    expect(resolvePermissions(permissions, "/elsewhere")).toEqual(["list"]);
  });

  it("matches a path exactly equal to a key", () => {
    expect(resolvePermissions({ "/a/b": ["list"] }, "/a/b")).toEqual(["list"]);
  });

  it("does not match a sibling path with a shared string prefix", () => {
    expect(resolvePermissions({ "/a/b": ["list"] }, "/a/bc")).toEqual([]);
  });

  it("normalizes a trailing slash on a key", () => {
    expect(resolvePermissions({ "/a/": ["list"] }, "/a/b")).toEqual(["list"]);
  });
});

describe("hasAction", () => {
  it("returns true when the action is present", () => {
    expect(hasAction(["list", "download"], "download")).toBe(true);
  });

  it("returns false when the action is absent", () => {
    expect(hasAction(["list"], "download")).toBe(false);
  });

  it("returns true for any action when the wildcard is present", () => {
    expect(hasAction(["*"], "anything")).toBe(true);
  });
});

describe("hasAnyAction", () => {
  it("returns true when at least one action matches", () => {
    expect(hasAnyAction(["rename"], ["rename", "rename_files"])).toBe(true);
  });

  it("returns false when none match", () => {
    expect(hasAnyAction(["list"], ["rename", "rename_files"])).toBe(false);
  });

  it("returns true via the wildcard", () => {
    expect(hasAnyAction(["*"], ["rename"])).toBe(true);
  });
});
