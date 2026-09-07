import type { BreadcrumbEntry } from "./path-url";

export interface BreadcrumbLayout {
  /** Crumbs rendered before the overflow ellipsis (empty when `compact`). */
  readonly head: readonly BreadcrumbEntry[];
  /** Crumbs collapsed behind the overflow ellipsis's dropdown. */
  readonly hidden: readonly BreadcrumbEntry[];
  /** Crumbs rendered after the overflow ellipsis, always including the
   * current (last) crumb. */
  readonly tail: readonly BreadcrumbEntry[];
  /** Whether an overflow ellipsis renders at all. */
  readonly collapsed: boolean;
}

/** Above this many crumbs, the desktop layout collapses the middle behind
 * an overflow ellipsis, keeping Home and the last two segments visible. */
const DESKTOP_COLLAPSE_THRESHOLD = 4;

const NO_CRUMBS: readonly BreadcrumbEntry[] = [];

/**
 * Decides how a breadcrumb trail collapses. The desktop layout keeps every
 * crumb visible up to `DESKTOP_COLLAPSE_THRESHOLD`; a longer trail
 * collapses the middle into an overflow ellipsis, keeping the first crumb
 * (Home) and the last two segments visible.
 *
 * `compact` (below the `md` breakpoint) instead truncates from the left:
 * once there is more than one crumb, only the current (last) segment stays
 * inline and every earlier one, including Home, moves behind the ellipsis,
 * so the current folder is never pushed off narrow screens.
 */
export function breadcrumbLayout(
  crumbs: readonly BreadcrumbEntry[],
  compact: boolean,
): BreadcrumbLayout {
  if (compact) {
    if (crumbs.length <= 1) {
      return { head: crumbs, hidden: NO_CRUMBS, tail: NO_CRUMBS, collapsed: false };
    }
    return {
      head: NO_CRUMBS,
      hidden: crumbs.slice(0, -1),
      tail: crumbs.slice(-1),
      collapsed: true,
    };
  }
  if (crumbs.length <= DESKTOP_COLLAPSE_THRESHOLD) {
    return { head: crumbs, hidden: NO_CRUMBS, tail: NO_CRUMBS, collapsed: false };
  }
  // Reachable only once `crumbs.length > DESKTOP_COLLAPSE_THRESHOLD`, so
  // index 0 is always present; the cast satisfies `noUncheckedIndexedAccess`
  // without an untestable defensive branch.
  const first = crumbs[0] as BreadcrumbEntry;
  return {
    head: [first],
    hidden: crumbs.slice(1, -2),
    tail: crumbs.slice(-2),
    collapsed: true,
  };
}
