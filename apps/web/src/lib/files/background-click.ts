/** The minimal shape of a DOM node this module needs to tell a row or tile
 * apart from the empty space around it. */
export interface ClosestElementLike {
  closest(selector: string): unknown;
}

/**
 * True when a click at `target` lands on genuinely empty listing space and
 * should clear the selection: not on a row or tile at all (no `[data-path]`
 * ancestor), and not on a listing control that is not part of the listing
 * itself, such as the sticky column header's "select all" checkbox, marked
 * with `[data-selection-exclude]`.
 *
 * A click on a row or tile's own background (its padding, the gaps between
 * its checkbox, chevron, icon, and text) is a row click, not background:
 * that element already selects itself through its own `onClick`, so
 * treating it as background here would immediately clear the selection that
 * click just produced, silently resetting a shift-click anchor.
 */
export function isBackgroundClick(target: ClosestElementLike | null): boolean {
  if (target === null) {
    return true;
  }
  if (target.closest("[data-selection-exclude]") !== null) {
    return false;
  }
  return target.closest("[data-path]") === null;
}
