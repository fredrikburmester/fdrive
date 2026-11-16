/** One action `FilesToolbarActions` can render: inline in the toolbar,
 * inside the "More" overflow menu, or inside the New menu. Search and New
 * are not part of this decision: Search lives in the page header, and New
 * always stays inline so there is always a way to create something. */
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
  /** Rendered at the top of the New menu instead, beside the other ways to add files. */
  readonly newMenu: readonly ToolbarActionId[];
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

const NEW_MENU_ACTIONS: readonly ToolbarActionId[] = ["upload"];

const OVERFLOW_ACTIONS = ALL_TOOLBAR_ACTIONS.filter((id) => !NEW_MENU_ACTIONS.includes(id));

/**
 * Decides which toolbar actions stay inline and which move into a menu.
 * Below Tailwind's `md` breakpoint (768px, the same threshold `useIsMobile`
 * tracks) the toolbar keeps only Search and New inline, so the header never
 * overflows horizontally at 320px and the folder name keeps the room: Upload
 * joins the New menu, one tap away instead of a submenu, and every other
 * action moves into "More". At `md` and up every action stays inline,
 * matching the unchanged desktop layout.
 */
export function toolbarVisibility(isMobile: boolean): ToolbarVisibility {
  if (isMobile) {
    return { inline: EMPTY_ACTIONS, overflow: OVERFLOW_ACTIONS, newMenu: NEW_MENU_ACTIONS };
  }
  return { inline: ALL_TOOLBAR_ACTIONS, overflow: EMPTY_ACTIONS, newMenu: EMPTY_ACTIONS };
}
