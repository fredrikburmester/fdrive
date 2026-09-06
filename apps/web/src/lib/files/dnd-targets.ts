import { movablePaths } from "./move-guard";

export type DropTargetState = "valid" | "invalid";

/**
 * Whether a folder at `targetDir` should highlight as a drop target for an
 * in-progress internal drag of `draggedPaths`: "valid" when at least one of
 * them can actually move there (see `movablePaths`), so a mixed selection
 * (some movable, some not, e.g. because one entry is `targetDir` itself)
 * still highlights the target instead of showing nothing. "invalid" covers
 * every entry `movablePaths` filters out: the source's own parent (a
 * no-op), the dragged item itself, and any of its descendants (a cycle).
 */
export function dropTargetState(
  draggedPaths: readonly string[],
  targetDir: string,
): DropTargetState {
  return movablePaths(draggedPaths, targetDir).length > 0 ? "valid" : "invalid";
}

/** The subset of a drag/drop event this module needs to read modifier keys. */
export interface EffectModifiers {
  readonly altKey: boolean;
}

/**
 * The drag effect implied by held modifier keys at drop time: `"copy"`
 * while Option/Alt is held, `"move"` otherwise, matching Finder.
 */
export function effectFor(modifiers: EffectModifiers): "move" | "copy" {
  return modifiers.altKey ? "copy" : "move";
}
