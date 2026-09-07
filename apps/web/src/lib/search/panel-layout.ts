/**
 * Which layout the search panel renders. Below the `md` breakpoint (the
 * same `useIsMobile` threshold the rest of the shell uses) it renders as a
 * full-screen sheet: full width, safe-area aware, no keyboard-oriented
 * footer. At `md` and up it stays the centered command dialog.
 */
export type SearchPanelLayout = "mobile" | "desktop";

/** Decides the search panel's layout from `useIsMobile`'s current value. */
export function searchPanelLayout(isMobile: boolean): SearchPanelLayout {
  return isMobile ? "mobile" : "desktop";
}
