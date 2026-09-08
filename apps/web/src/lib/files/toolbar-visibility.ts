/** One action `FilesToolbarActions` can render, either inline in the
 * toolbar or inside the "More" overflow menu. Search and New are not part
 * of this decision: Search lives in the page header, and New always stays
 * inline so there is always a way to create something. */
export type ToolbarActionId =
  | "view"
  | "upload"
  | "duplicate"
  | "compress"
  | "download"
  | "details"
  | "clearSelection";

export interface ToolbarVisibility {
  /** Rendered directly in the toolbar. */
  readonly inline: readonly ToolbarActionId[];
  /** Rendered inside the "More" overflow menu instead. */
  readonly overflow: readonly ToolbarActionId[];
}

const ALL_TOOLBAR_ACTIONS: readonly ToolbarActionId[] = [
  "view",
  "upload",
  "duplicate",
  "compress",
  "download",
  "details",
  "clearSelection",
];

const EMPTY_ACTIONS: readonly ToolbarActionId[] = [];

/**
 * Decides which toolbar actions stay inline and which move into the
 * "More" overflow menu. Below Tailwind's `md` breakpoint (768px, the same
 * threshold `useIsMobile` tracks) the toolbar keeps only Search and New
 * inline and moves every other action into "More", so the header never
 * overflows horizontally at 320px. At `md` and up every action stays
 * inline, matching the unchanged desktop layout.
 */
export function toolbarVisibility(isMobile: boolean): ToolbarVisibility {
  if (isMobile) {
    return { inline: EMPTY_ACTIONS, overflow: ALL_TOOLBAR_ACTIONS };
  }
  return { inline: ALL_TOOLBAR_ACTIONS, overflow: EMPTY_ACTIONS };
}
