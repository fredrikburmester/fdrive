import { isRoot, parentPath } from "@fdrive/core";
import { readJson, type StorageLike, writeJson } from "./storage";

/**
 * Which folder paths are expanded in a folder tree (the sidebar tree or the
 * main browser's tree view). Both share this shape and the same storage
 * key, so expanding a folder in one place is remembered in the other.
 */
export interface TreeState {
  readonly expanded: ReadonlySet<string>;
}

export const EMPTY_TREE_STATE: TreeState = { expanded: new Set() };

export const TREE_STORAGE_KEY = "fdrive.tree";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Reads the persisted set of expanded tree paths from `storage`. */
export function readTreeState(storage: StorageLike): TreeState {
  const paths = readJson(storage, TREE_STORAGE_KEY, isStringArray, []);
  return { expanded: new Set(paths) };
}

/** Persists `state`'s expanded paths to `storage` under `fdrive.tree`. */
export function writeTreeState(storage: StorageLike, state: TreeState): void {
  writeJson(storage, TREE_STORAGE_KEY, Array.from(state.expanded));
}

/** Expands `path`; a no-op (returning the same reference) if already expanded. */
export function expand(state: TreeState, path: string): TreeState {
  if (state.expanded.has(path)) {
    return state;
  }
  return { expanded: new Set(state.expanded).add(path) };
}

/** Collapses `path`; a no-op (returning the same reference) if not expanded. */
export function collapse(state: TreeState, path: string): TreeState {
  if (!state.expanded.has(path)) {
    return state;
  }
  const next = new Set(state.expanded);
  next.delete(path);
  return { expanded: next };
}

/** Flips `path` between expanded and collapsed. */
export function toggle(state: TreeState, path: string): TreeState {
  return state.expanded.has(path) ? collapse(state, path) : expand(state, path);
}

/**
 * Every proper ancestor of `path`, root-most first, excluding `path`
 * itself. `[]` when `path` is already the root.
 */
export function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let current = path;
  while (!isRoot(current)) {
    current = parentPath(current);
    ancestors.unshift(current);
  }
  return ancestors;
}

/**
 * Expands every ancestor of `path` (but not `path` itself), so the tree can
 * reveal the node matching the current route without the user having
 * manually expanded its parents.
 */
export function expandAncestorsOf(state: TreeState, path: string): TreeState {
  const ancestors = ancestorsOf(path);
  if (ancestors.every((ancestor) => state.expanded.has(ancestor))) {
    return state;
  }
  const next = new Set(state.expanded);
  for (const ancestor of ancestors) {
    next.add(ancestor);
  }
  return { expanded: next };
}

/**
 * Drops any expanded path that is not in `existingPaths`, e.g. after a
 * folder the tree had expanded is deleted, renamed, or moved away. The root
 * is never dropped implicitly by callers; pass it in `existingPaths` if it
 * should be kept.
 */
export function reconcile(state: TreeState, existingPaths: readonly string[]): TreeState {
  const existing = new Set(existingPaths);
  const next = new Set([...state.expanded].filter((path) => existing.has(path)));
  if (next.size === state.expanded.size) {
    return state;
  }
  return { expanded: next };
}

/**
 * Every path known to exist because it appears as a parent or a child
 * somewhere in `childrenByPath` (plus the root), for pruning `TreeState`
 * with `reconcile` as new listings arrive.
 */
export function knownTreePaths(childrenByPath: ReadonlyMap<string, readonly string[]>): string[] {
  const known = new Set<string>(["/"]);
  for (const [parent, children] of childrenByPath) {
    known.add(parent);
    for (const child of children) {
      known.add(child);
    }
  }
  return Array.from(known);
}

/** One row of a flattened, depth-annotated tree, for keyboard navigation. */
export interface VisibleTreeNode {
  readonly path: string;
  readonly depth: number;
}

/**
 * Flattens the currently visible (expanded) portion of a folder tree into
 * an ordered list, depth-first, for Up/Down keyboard navigation.
 * `childrenByPath` holds each path's known child folder paths, in display
 * order; a path with no entry in `childrenByPath` is treated as not yet
 * loaded, so its subtree (even if expanded) contributes no rows yet.
 */
export function flattenVisibleTree(
  roots: readonly string[],
  childrenByPath: ReadonlyMap<string, readonly string[]>,
  expanded: ReadonlySet<string>,
): VisibleTreeNode[] {
  const rows: VisibleTreeNode[] = [];

  function visit(paths: readonly string[], depth: number): void {
    for (const path of paths) {
      rows.push({ path, depth });
      if (expanded.has(path)) {
        const children = childrenByPath.get(path);
        if (children !== undefined) {
          visit(children, depth + 1);
        }
      }
    }
  }

  visit(roots, 0);
  return rows;
}

export type TreeMoveDirection = "up" | "down";

/**
 * The path to focus after moving `direction` through `rows` from
 * `currentPath`. Falls back to the first row (moving down) or the last row
 * (moving up) when nothing is focused yet. `null` when `rows` is empty.
 */
export function moveVisibleFocus(
  rows: readonly VisibleTreeNode[],
  currentPath: string | null,
  direction: TreeMoveDirection,
): string | null {
  if (rows.length === 0) {
    return null;
  }
  const currentIndex =
    currentPath === null ? -1 : rows.findIndex((row) => row.path === currentPath);
  const delta = direction === "up" ? -1 : 1;
  const fallback = direction === "up" ? rows.length - 1 : 0;
  const nextIndex =
    currentIndex === -1 ? fallback : Math.min(Math.max(currentIndex + delta, 0), rows.length - 1);
  return rows[nextIndex]?.path ?? null;
}

export type TreeLeftResult =
  | { readonly type: "collapse" }
  | { readonly type: "focusParent"; readonly path: string }
  | { readonly type: "none" };

/**
 * What the Left arrow should do for the focused `path`: collapse it if
 * expanded, otherwise move focus to its parent (or do nothing at the root).
 */
export function leftAction(state: TreeState, path: string): TreeLeftResult {
  if (state.expanded.has(path)) {
    return { type: "collapse" };
  }
  if (isRoot(path)) {
    return { type: "none" };
  }
  return { type: "focusParent", path: parentPath(path) };
}

export type TreeRightResult =
  | { readonly type: "expand" }
  | { readonly type: "focusChild"; readonly path: string }
  | { readonly type: "none" };

/**
 * What the Right arrow should do for the focused `path`: expand it if
 * collapsed, otherwise move focus to its first known child (or do nothing
 * when it has none, or none are loaded yet).
 */
export function rightAction(
  state: TreeState,
  path: string,
  firstChildPath: string | null,
): TreeRightResult {
  if (!state.expanded.has(path)) {
    return { type: "expand" };
  }
  if (firstChildPath !== null) {
    return { type: "focusChild", path: firstChildPath };
  }
  return { type: "none" };
}
