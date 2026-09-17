import { readJson, type StorageLike, writeJson } from "./storage";

/**
 * What a plain (unmodified) click on a listing row or grid tile does:
 * "select" replaces the selection with that item, "toggle" adds or removes
 * it like its checkbox, "highlight" moves the keyboard focus to it without
 * changing the selection, and "open" opens it. Shift-click and Cmd/Ctrl-click
 * keep their range and toggle meaning in every mode, and Enter or a
 * double-click still opens in every mode but "open".
 */
export type RowClickAction = "select" | "toggle" | "highlight" | "open";

/** localStorage key for the row-click preference. */
export const ROW_CLICK_STORAGE_KEY = "fdrive.list.rowClick";

export const DEFAULT_ROW_CLICK_ACTION: RowClickAction = "select";

export const ROW_CLICK_ACTIONS: readonly RowClickAction[] = [
  "select",
  "toggle",
  "highlight",
  "open",
];

function isRowClickAction(value: unknown): value is RowClickAction {
  return value === "select" || value === "toggle" || value === "highlight" || value === "open";
}

/** Reads the persisted row-click preference from `storage`, falling back to "select". */
export function readRowClickAction(storage: StorageLike): RowClickAction {
  return readJson(storage, ROW_CLICK_STORAGE_KEY, isRowClickAction, DEFAULT_ROW_CLICK_ACTION);
}

/** Persists `action` to `storage` under the shared `fdrive.list.rowClick` key. */
export function writeRowClickAction(storage: StorageLike, action: RowClickAction): void {
  writeJson(storage, ROW_CLICK_STORAGE_KEY, action);
}

export interface RowClickModifiers {
  readonly shift: boolean;
  readonly meta: boolean;
}

/**
 * What a listing should do for a click, resolved from the preference and the
 * held modifiers: feed the selection model, move the focus only, or open.
 */
export type RowClickIntent =
  | { readonly kind: "select"; readonly modifiers: RowClickModifiers }
  | { readonly kind: "focus" }
  | { readonly kind: "open" };

/**
 * Resolves a row click to an intent. A modified click (Shift or Cmd/Ctrl)
 * always feeds the selection model unchanged so range and toggle selection
 * keep working; only a plain click follows `action`.
 */
export function resolveRowClick(
  action: RowClickAction,
  modifiers: RowClickModifiers,
): RowClickIntent {
  if (modifiers.shift || modifiers.meta) {
    return { kind: "select", modifiers };
  }
  switch (action) {
    case "select":
      return { kind: "select", modifiers };
    case "toggle":
      return { kind: "select", modifiers: { shift: false, meta: true } };
    case "highlight":
      return { kind: "focus" };
    case "open":
      return { kind: "open" };
  }
}
