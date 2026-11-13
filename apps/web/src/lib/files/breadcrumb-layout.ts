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
  /** The width, in pixels, every visible name is truncated to so the trail
   * fits, or `null` when names keep their natural width. */
  readonly nameMaxWidth: number | null;
}

/** One crumb's measured widths, in pixels. */
export interface CrumbWidth {
  /** The name at its natural width, padding included. */
  readonly name: number;
  /** The separator and gaps that follow the name (none for the last crumb). */
  readonly trailing: number;
}

/** Measured widths, in pixels, that decide how much of a desktop trail fits. */
export interface BreadcrumbWidths {
  /** The width the trail can take up. */
  readonly available: number;
  /** Each crumb's widths, in trail order. */
  readonly crumbs: readonly CrumbWidth[];
  /** The overflow ellipsis's width, including the separator and gaps that
   * follow it. */
  readonly ellipsis: number;
}

/** How narrow names may be truncated before the trail hides ancestors instead. */
const MIN_NAME_WIDTH = 80;

const NO_CRUMBS: readonly BreadcrumbEntry[] = [];

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * The widest every name can stay so `crumbs` fit `space` together, with
 * names shorter than that keeping their full width; `null` when every name
 * fits whole.
 */
function nameCap(crumbs: readonly CrumbWidth[], space: number): number | null {
  const names = crumbs.map((crumb) => crumb.name).sort((a, b) => a - b);
  let remaining = space - sum(crumbs.map((crumb) => crumb.trailing));
  let whole = 0;
  for (const name of names) {
    if (name * (names.length - whole) > remaining) {
      break;
    }
    remaining -= name;
    whole += 1;
  }
  return whole === names.length ? null : Math.max(remaining / (names.length - whole), 0);
}

function readable(cap: number | null): boolean {
  return cap === null || cap >= MIN_NAME_WIDTH;
}

/** Only the current (last) crumb inline, every earlier one behind the
 * ellipsis; just Home stays whole at the root. */
function leftTruncated(crumbs: readonly BreadcrumbEntry[]): BreadcrumbLayout {
  if (crumbs.length <= 1) {
    return {
      head: crumbs,
      hidden: NO_CRUMBS,
      tail: NO_CRUMBS,
      collapsed: false,
      nameMaxWidth: null,
    };
  }
  return {
    head: NO_CRUMBS,
    hidden: crumbs.slice(0, -1),
    tail: crumbs.slice(-1),
    collapsed: true,
    nameMaxWidth: null,
  };
}

/**
 * Decides how a breadcrumb trail collapses. The desktop layout keeps every
 * crumb visible while the trail fits `widths.available`, truncating the
 * longest names evenly when it is a little short. Once names would drop
 * below `MIN_NAME_WIDTH`, it hides the shallowest ancestors behind an
 * overflow ellipsis instead, one at a time, keeping the first crumb (Home)
 * and as many of the deepest segments as fit. When even Home and the
 * current folder alone are too tight, it truncates from the left like
 * `compact`. Without `widths` (before the first measurement) every crumb
 * renders at its natural width.
 *
 * `compact` (below the `md` breakpoint) always truncates from the left:
 * once there is more than one crumb, only the current (last) segment stays
 * inline and every earlier one, including Home, moves behind the ellipsis,
 * so the current folder is never pushed off narrow screens.
 */
export function breadcrumbLayout(
  crumbs: readonly BreadcrumbEntry[],
  compact: boolean,
  widths?: BreadcrumbWidths | null,
): BreadcrumbLayout {
  if (compact) {
    return leftTruncated(crumbs);
  }
  const wholeCap = widths ? nameCap(widths.crumbs, widths.available) : null;
  if (!widths || crumbs.length <= 1 || readable(wholeCap)) {
    return {
      head: crumbs,
      hidden: NO_CRUMBS,
      tail: NO_CRUMBS,
      collapsed: false,
      nameMaxWidth: wholeCap,
    };
  }
  const home = widths.crumbs.slice(0, 1);
  for (let tailStart = 2; tailStart < crumbs.length; tailStart += 1) {
    const cap = nameCap(
      [...home, ...widths.crumbs.slice(tailStart)],
      widths.available - widths.ellipsis,
    );
    if (readable(cap)) {
      return {
        head: crumbs.slice(0, 1),
        hidden: crumbs.slice(1, tailStart),
        tail: crumbs.slice(tailStart),
        collapsed: true,
        nameMaxWidth: cap,
      };
    }
  }
  return leftTruncated(crumbs);
}
