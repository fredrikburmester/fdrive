/**
 * A pure selection model over an ordered list of paths (the currently
 * visible listing, in display order). `anchor` is the fixed end of a
 * shift-click/arrow range, `focus` is the moving end that keyboard
 * navigation advances.
 */
export interface SelectionState {
  readonly anchor: string | null;
  readonly focus: string | null;
  readonly selected: ReadonlySet<string>;
}

export const EMPTY_SELECTION: SelectionState = {
  anchor: null,
  focus: null,
  selected: new Set(),
};

export interface ClickModifiers {
  readonly shift?: boolean;
  readonly meta?: boolean;
}

export interface ArrowModifiers {
  readonly shift?: boolean;
}

export type ArrowDirection = "up" | "down";

/** The inclusive range of `order` between `from` and `to`, in either order. */
function rangeBetween(order: readonly string[], from: string, to: string): string[] {
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) {
    return [to];
  }
  const [start, end] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
  return order.slice(start, end + 1);
}

/**
 * Applies a click on `path` to `state`, given the visible `order` and
 * modifier keys. Plain click replaces the selection; meta/cmd-click toggles
 * membership; shift-click extends the range from the current anchor.
 */
export function click(
  state: SelectionState,
  order: readonly string[],
  path: string,
  modifiers: ClickModifiers = {},
): SelectionState {
  if (modifiers.shift) {
    const anchor = state.anchor ?? path;
    const selected = new Set(rangeBetween(order, anchor, path));
    return { anchor, focus: path, selected };
  }

  if (modifiers.meta) {
    const selected = new Set(state.selected);
    if (selected.has(path)) {
      selected.delete(path);
    } else {
      selected.add(path);
    }
    return { anchor: path, focus: path, selected };
  }

  return { anchor: path, focus: path, selected: new Set([path]) };
}

/**
 * Moves the focus (and the range anchor) to `path` without touching the
 * selection, for a "highlight" row click: the row gets the focus ring so
 * Enter opens it and a later shift-click ranges from it, but toolbar and
 * context actions keep targeting whatever was selected before.
 */
export function focus(state: SelectionState, path: string): SelectionState {
  if (state.anchor === path && state.focus === path) {
    return state;
  }
  return { anchor: path, focus: path, selected: state.selected };
}

/**
 * Moves the keyboard focus one step `direction` through `order`. Plain
 * arrow replaces the selection with the new focus; shift-arrow extends the
 * range from the anchor (falling back to the previous focus when there is
 * no anchor yet).
 */
export function arrow(
  state: SelectionState,
  order: readonly string[],
  direction: ArrowDirection,
  modifiers: ArrowModifiers = {},
): SelectionState {
  if (order.length === 0) {
    return state;
  }

  const currentIndex = state.focus === null ? -1 : order.indexOf(state.focus);
  const delta = direction === "up" ? -1 : 1;
  const fallbackStart = direction === "up" ? order.length - 1 : 0;
  const nextIndex =
    currentIndex === -1
      ? fallbackStart
      : Math.min(Math.max(currentIndex + delta, 0), order.length - 1);
  const nextFocus = order[nextIndex];
  if (nextFocus === undefined) {
    return state;
  }

  if (modifiers.shift) {
    const anchor = state.anchor ?? state.focus ?? nextFocus;
    const selected = new Set(rangeBetween(order, anchor, nextFocus));
    return { anchor, focus: nextFocus, selected };
  }

  return { anchor: nextFocus, focus: nextFocus, selected: new Set([nextFocus]) };
}

/** Selects every path in `order`. */
export function selectAll(order: readonly string[]): SelectionState {
  if (order.length === 0) {
    return EMPTY_SELECTION;
  }
  const first = order[0] ?? null;
  const last = order.at(-1) ?? null;
  return { anchor: first, focus: last, selected: new Set(order) };
}

/** Deselects everything and resets the anchor and focus. */
export function clear(): SelectionState {
  return EMPTY_SELECTION;
}

/**
 * Toggles between "every visible row selected" and "none selected", for a
 * header checkbox. Selects all of `visiblePaths` unless every one of them is
 * already selected, in which case it clears the selection instead (matching
 * a tri-state checkbox: unchecked or indeterminate both toggle to checked,
 * checked toggles to unchecked).
 */
export function toggleAll(state: SelectionState, visiblePaths: readonly string[]): SelectionState {
  const allSelected =
    visiblePaths.length > 0 && visiblePaths.every((path) => state.selected.has(path));
  return allSelected ? clear() : selectAll(visiblePaths);
}

/** Replaces the selection with exactly `paths`. */
export function set(paths: readonly string[]): SelectionState {
  if (paths.length === 0) {
    return EMPTY_SELECTION;
  }
  const first = paths[0] ?? null;
  const last = paths.at(-1) ?? null;
  return { anchor: first, focus: last, selected: new Set(paths) };
}

/**
 * Drops any selected, anchor, or focus path that no longer appears in
 * `currentPaths`, e.g. after a listing refetch removes an entry.
 */
export function reconcile(state: SelectionState, currentPaths: readonly string[]): SelectionState {
  const currentSet = new Set(currentPaths);
  const selected = new Set([...state.selected].filter((path) => currentSet.has(path)));
  const anchor = state.anchor !== null && currentSet.has(state.anchor) ? state.anchor : null;
  const focus = state.focus !== null && currentSet.has(state.focus) ? state.focus : null;

  if (selected.size === state.selected.size && anchor === state.anchor && focus === state.focus) {
    return state;
  }

  return { anchor, focus, selected };
}

/**
 * A discriminated union of every selection change, so a component can drive
 * `SelectionState` through a single `useReducer` call. `order` (the current
 * listing order) is threaded in separately since it changes independently
 * of the action itself.
 */
export type SelectionAction =
  | { readonly type: "click"; readonly path: string; readonly modifiers?: ClickModifiers }
  | { readonly type: "focus"; readonly path: string }
  | {
      readonly type: "arrow";
      readonly direction: ArrowDirection;
      readonly modifiers?: ArrowModifiers;
    }
  | { readonly type: "selectAll" }
  | { readonly type: "clear" }
  | { readonly type: "set"; readonly paths: readonly string[] }
  | { readonly type: "reconcile"; readonly paths: readonly string[] }
  | { readonly type: "toggleAll"; readonly visiblePaths: readonly string[] };

/** Applies `action` to `state`, given the current listing `order`. */
export function selectionReducer(
  state: SelectionState,
  action: SelectionAction,
  order: readonly string[],
): SelectionState {
  switch (action.type) {
    case "click":
      return click(state, order, action.path, action.modifiers);
    case "focus":
      return focus(state, action.path);
    case "arrow":
      return arrow(state, order, action.direction, action.modifiers);
    case "selectAll":
      return selectAll(order);
    case "clear":
      return clear();
    case "set":
      return set(action.paths);
    case "reconcile":
      return reconcile(state, action.paths);
    case "toggleAll":
      return toggleAll(state, action.visiblePaths);
  }
}

/**
 * How many entries a context-menu or toolbar action on `path` would apply
 * to: the whole selection's size when `path` is part of a multi-entry
 * selection, else just 1 (right-clicking or acting on an unselected row
 * only ever targets that one row, matching Finder).
 */
export function contextSelectionCount(path: string, selected: ReadonlySet<string>): number {
  return selected.has(path) ? Math.max(selected.size, 1) : 1;
}

/**
 * The group of entries a context-menu or toolbar action on `entry` would
 * apply to: every selected entry (in `entries`' order) when `entry` is part
 * of a multi-entry selection, else just `entry` itself, mirroring
 * `contextSelectionCount`'s rule for how many entries an action targets.
 */
export function contextEntries<T extends { path: string }>(
  entry: T,
  entries: readonly T[],
  selected: ReadonlySet<string>,
): T[] {
  if (selected.has(entry.path) && selected.size > 1) {
    return entries.filter((candidate) => selected.has(candidate.path));
  }
  return [entry];
}
