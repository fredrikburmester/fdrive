import { describe, expect, it } from "vitest";
import type { StorageLike } from "./storage";
import {
  ancestorsOf,
  chevronStateFor,
  collapse,
  EMPTY_TREE_STATE,
  expand,
  expandAncestorsOf,
  flattenVisibleTree,
  knownTreePaths,
  leftAction,
  moveVisibleFocus,
  readTreeState,
  reconcile,
  rightAction,
  shouldShowSkeleton,
  TREE_STORAGE_KEY,
  type TreeState,
  toggle,
  writeTreeState,
} from "./tree";

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function stateWith(...paths: string[]): TreeState {
  return { expanded: new Set(paths) };
}

describe("expand", () => {
  it("adds path to the expanded set", () => {
    const next = expand(EMPTY_TREE_STATE, "/a");
    expect(next.expanded.has("/a")).toBe(true);
  });

  it("returns the same reference when already expanded", () => {
    const state = stateWith("/a");
    expect(expand(state, "/a")).toBe(state);
  });
});

describe("collapse", () => {
  it("removes path from the expanded set", () => {
    const next = collapse(stateWith("/a", "/b"), "/a");
    expect(next.expanded.has("/a")).toBe(false);
    expect(next.expanded.has("/b")).toBe(true);
  });

  it("returns the same reference when not expanded", () => {
    const state = stateWith("/b");
    expect(collapse(state, "/a")).toBe(state);
  });
});

describe("toggle", () => {
  it("expands a collapsed path", () => {
    expect(toggle(EMPTY_TREE_STATE, "/a").expanded.has("/a")).toBe(true);
  });

  it("collapses an expanded path", () => {
    expect(toggle(stateWith("/a"), "/a").expanded.has("/a")).toBe(false);
  });
});

describe("ancestorsOf", () => {
  it("is empty for the root", () => {
    expect(ancestorsOf("/")).toEqual([]);
  });

  it("is just the root for a top-level path", () => {
    expect(ancestorsOf("/a")).toEqual(["/"]);
  });

  it("lists ancestors root-most first, including the root", () => {
    expect(ancestorsOf("/a/b/c")).toEqual(["/", "/a", "/a/b"]);
  });
});

describe("expandAncestorsOf", () => {
  it("expands every ancestor of a nested path, including the root", () => {
    const next = expandAncestorsOf(EMPTY_TREE_STATE, "/a/b/c");
    expect([...next.expanded].sort()).toEqual(["/", "/a", "/a/b"]);
  });

  it("returns the same reference when all ancestors are already expanded", () => {
    const state = stateWith("/", "/a", "/a/b");
    expect(expandAncestorsOf(state, "/a/b/c")).toBe(state);
  });

  it("expands just the root for a top-level path", () => {
    expect(expandAncestorsOf(EMPTY_TREE_STATE, "/a").expanded).toEqual(new Set(["/"]));
  });

  it("is a no-op for the root itself", () => {
    expect(expandAncestorsOf(EMPTY_TREE_STATE, "/")).toBe(EMPTY_TREE_STATE);
  });
});

describe("reconcile", () => {
  it("drops expanded paths that no longer exist", () => {
    const next = reconcile(stateWith("/a", "/b"), ["/a"]);
    expect(next.expanded.has("/a")).toBe(true);
    expect(next.expanded.has("/b")).toBe(false);
  });

  it("returns the same reference when nothing changes", () => {
    const state = stateWith("/a");
    expect(reconcile(state, ["/a", "/b"])).toBe(state);
  });
});

describe("knownTreePaths", () => {
  it("collects the root, parents, and children", () => {
    const map = new Map<string, readonly string[]>([
      ["/", ["/a"]],
      ["/a", ["/a/b", "/a/c"]],
    ]);
    expect(new Set(knownTreePaths(map))).toEqual(new Set(["/", "/a", "/a/b", "/a/c"]));
  });

  it("includes just the root for an empty map", () => {
    expect(knownTreePaths(new Map())).toEqual(["/"]);
  });
});

describe("flattenVisibleTree", () => {
  it("lists only the roots when nothing is expanded", () => {
    expect(flattenVisibleTree(["/a", "/b"], new Map(), new Set())).toEqual([
      { path: "/a", depth: 0 },
      { path: "/b", depth: 0 },
    ]);
  });

  it("descends into expanded, loaded children", () => {
    const childrenByPath = new Map<string, readonly string[]>([["/a", ["/a/x", "/a/y"]]]);
    expect(flattenVisibleTree(["/a", "/b"], childrenByPath, new Set(["/a"]))).toEqual([
      { path: "/a", depth: 0 },
      { path: "/a/x", depth: 1 },
      { path: "/a/y", depth: 1 },
      { path: "/b", depth: 0 },
    ]);
  });

  it("does not descend into an expanded path with no loaded children yet", () => {
    expect(flattenVisibleTree(["/a"], new Map(), new Set(["/a"]))).toEqual([
      { path: "/a", depth: 0 },
    ]);
  });

  it("recurses multiple levels deep", () => {
    const childrenByPath = new Map<string, readonly string[]>([
      ["/a", ["/a/b"]],
      ["/a/b", ["/a/b/c"]],
    ]);
    expect(flattenVisibleTree(["/a"], childrenByPath, new Set(["/a", "/a/b"]))).toEqual([
      { path: "/a", depth: 0 },
      { path: "/a/b", depth: 1 },
      { path: "/a/b/c", depth: 2 },
    ]);
  });
});

describe("moveVisibleFocus", () => {
  const rows = [
    { path: "/a", depth: 0 },
    { path: "/b", depth: 0 },
    { path: "/c", depth: 0 },
  ];

  it("returns null for an empty list", () => {
    expect(moveVisibleFocus([], "/a", "down")).toBeNull();
  });

  it("focuses the first row moving down from nothing focused", () => {
    expect(moveVisibleFocus(rows, null, "down")).toBe("/a");
  });

  it("focuses the last row moving up from nothing focused", () => {
    expect(moveVisibleFocus(rows, null, "up")).toBe("/c");
  });

  it("moves down one row", () => {
    expect(moveVisibleFocus(rows, "/a", "down")).toBe("/b");
  });

  it("moves up one row", () => {
    expect(moveVisibleFocus(rows, "/c", "up")).toBe("/b");
  });

  it("clamps at the last row", () => {
    expect(moveVisibleFocus(rows, "/c", "down")).toBe("/c");
  });

  it("clamps at the first row", () => {
    expect(moveVisibleFocus(rows, "/a", "up")).toBe("/a");
  });

  it("falls back to the first row when the current path is not in the list", () => {
    expect(moveVisibleFocus(rows, "/missing", "down")).toBe("/a");
  });
});

describe("leftAction", () => {
  it("collapses an expanded path", () => {
    expect(leftAction(stateWith("/a"), "/a")).toEqual({ type: "collapse" });
  });

  it("moves focus to the parent of a collapsed path", () => {
    expect(leftAction(EMPTY_TREE_STATE, "/a/b")).toEqual({
      type: "focusParent",
      path: "/a",
    });
  });

  it("does nothing at the root", () => {
    expect(leftAction(EMPTY_TREE_STATE, "/")).toEqual({ type: "none" });
  });
});

describe("rightAction", () => {
  it("expands a collapsed path", () => {
    expect(rightAction(EMPTY_TREE_STATE, "/a", null)).toEqual({ type: "expand" });
  });

  it("moves focus to the first child of an expanded path", () => {
    expect(rightAction(stateWith("/a"), "/a", "/a/x")).toEqual({
      type: "focusChild",
      path: "/a/x",
    });
  });

  it("does nothing for an expanded path with no known children", () => {
    expect(rightAction(stateWith("/a"), "/a", null)).toEqual({ type: "none" });
  });
});

describe("readTreeState", () => {
  it("falls back to nothing expanded when storage is empty", () => {
    expect(readTreeState(memoryStorage()).expanded.size).toBe(0);
  });

  it("reads persisted expanded paths", () => {
    const storage = memoryStorage({ [TREE_STORAGE_KEY]: JSON.stringify(["/a", "/a/b"]) });
    expect(readTreeState(storage).expanded).toEqual(new Set(["/a", "/a/b"]));
  });

  it("falls back when the stored value is not an array of strings", () => {
    const storage = memoryStorage({ [TREE_STORAGE_KEY]: JSON.stringify({ nope: true }) });
    expect(readTreeState(storage).expanded.size).toBe(0);
  });
});

describe("chevronStateFor", () => {
  it("is unknown while the listing has not resolved", () => {
    expect(chevronStateFor({ status: "unknown" })).toBe("unknown");
  });

  it("is expandable once the listing is known to contain subfolders", () => {
    expect(chevronStateFor({ status: "known", hasSubfolders: true })).toBe("expandable");
  });

  it("is leaf once the listing is known to contain none", () => {
    expect(chevronStateFor({ status: "known", hasSubfolders: false })).toBe("leaf");
  });
});

describe("shouldShowSkeleton", () => {
  it("is false before the delay has elapsed", () => {
    expect(shouldShowSkeleton(1_000, 1_100, 200)).toBe(false);
  });

  it("is true once the delay has elapsed", () => {
    expect(shouldShowSkeleton(1_000, 1_200, 200)).toBe(true);
  });

  it("is true well past the delay", () => {
    expect(shouldShowSkeleton(1_000, 5_000, 200)).toBe(true);
  });

  it("is false at the instant loading started", () => {
    expect(shouldShowSkeleton(1_000, 1_000, 200)).toBe(false);
  });
});

describe("writeTreeState", () => {
  it("persists the expanded paths as an array", () => {
    const storage = memoryStorage();
    writeTreeState(storage, stateWith("/a", "/b"));
    expect(new Set(JSON.parse(storage.getItem(TREE_STORAGE_KEY) ?? "[]"))).toEqual(
      new Set(["/a", "/b"]),
    );
  });
});
