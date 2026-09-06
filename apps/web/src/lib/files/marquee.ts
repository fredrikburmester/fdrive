/**
 * A point in the scroll container's content coordinate space (i.e. relative
 * to the scrolled content itself, unaffected by the current scroll offset),
 * the same space the virtualizer positions rows and tiles in.
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** An axis-aligned rectangle in the same coordinate space as `Point`,
 * always normalized so `left <= right` and `top <= bottom`. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** One selectable item's bounding box for marquee hit testing, in the
 * scroll container's content coordinate space. */
export interface LayoutItem {
  readonly path: string;
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Normalizes two arbitrary corner points, such as a pointer's drag-start
 * position and its current position, into a `Rect`, regardless of which
 * direction the pointer moved between them.
 */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** True when `rect` and `item`'s box overlap by any amount; edges that only
 * touch, with no overlapping area, do not count. */
function intersects(rect: Rect, item: LayoutItem): boolean {
  const itemRight = item.left + item.width;
  const itemBottom = item.top + item.height;
  return (
    rect.left < itemRight &&
    rect.right > item.left &&
    rect.top < itemBottom &&
    rect.bottom > item.top
  );
}

/**
 * The paths of every item in `layout` that overlaps `rect`, including a
 * merely partial overlap at an edge, matching a Finder-style rubber-band
 * selection.
 */
export function itemsInRect(rect: Rect, layout: readonly LayoutItem[]): string[] {
  return layout.filter((item) => intersects(rect, item)).map((item) => item.path);
}

/**
 * True once a pointer has moved far enough from `start` to count as a real
 * drag rather than a stationary click, using Euclidean distance so it does
 * not matter which direction the pointer moved.
 */
export function passesDragThreshold(start: Point, current: Point, thresholdPx = 4): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= thresholdPx;
}

/**
 * How fast to auto-scroll a listing while a marquee drag's pointer sits
 * within `edgePx` of the scroll container's visible top or bottom edge:
 * negative scrolls up, positive scrolls down, `0` outside both edge zones.
 * Ramps linearly from `0` at the edge boundary up to `maxSpeed` at (or past)
 * the edge itself.
 */
export function autoScrollSpeed(
  pointerY: number,
  containerTop: number,
  containerHeight: number,
  edgePx = 24,
  maxSpeed = 16,
): number {
  const relativeY = pointerY - containerTop;
  const distanceFromTop = relativeY;
  const distanceFromBottom = containerHeight - relativeY;

  if (distanceFromTop < edgePx) {
    const intensity = Math.min(1, Math.max(0, edgePx - distanceFromTop) / edgePx);
    return -maxSpeed * intensity;
  }
  if (distanceFromBottom < edgePx) {
    const intensity = Math.min(1, Math.max(0, edgePx - distanceFromBottom) / edgePx);
    return maxSpeed * intensity;
  }
  return 0;
}

export type MarqueeMode = "replace" | "add";

/**
 * The full, ordered selection a marquee drag should produce for one frame
 * of the gesture: just `covered` in `"replace"` mode (a plain drag, which
 * replaces the selection), or `baseSelected` (the selection captured when
 * the drag started) followed by any of `covered` not already in it, in
 * `"add"` mode (a Cmd/Ctrl or Shift drag). Returning a plain ordered array
 * lets the caller drive the whole gesture through the selection reducer's
 * existing `"set"` action.
 */
export function marqueeSelection(
  baseSelected: readonly string[],
  covered: readonly string[],
  mode: MarqueeMode,
): string[] {
  if (mode === "replace") {
    return [...covered];
  }
  const result = [...baseSelected];
  const seen = new Set(baseSelected);
  for (const path of covered) {
    if (!seen.has(path)) {
      seen.add(path);
      result.push(path);
    }
  }
  return result;
}

/** The minimal shape of a DOM node this module needs to tell a row or
 * tile's own background apart from its interactive content. */
export interface ClosestElementLike {
  closest(selector: string): unknown;
}

/**
 * True when a pointerdown (or, with no further movement, a click) at
 * `target` counts as empty listing space rather than a row or tile: either
 * fully outside any entry (no `[data-path]` ancestor at all) or exactly on
 * that entry's own background, such as its padding or the gaps between its
 * checkbox, chevron, icon, and text, as opposed to landing on one of those
 * elements itself.
 *
 * Anything under a `[data-marquee-exclude]` ancestor is never empty space,
 * regardless of `[data-path]`: the sticky column header (list/tree view)
 * lives inside the same scroll container the marquee listens on, but its
 * own controls (the "select all" checkbox, column labels) are not part of
 * the listing and must never arm a marquee drag or clear the selection.
 */
export function isMarqueeStartTarget(target: ClosestElementLike | null): boolean {
  if (target === null) {
    return true;
  }
  if (target.closest("[data-marquee-exclude]") !== null) {
    return false;
  }
  const row = target.closest("[data-path]");
  return row === null || row === target;
}

/** One item's exact measurement from the virtualizer's visible range. */
export interface VirtualMeasurement {
  readonly index: number;
  readonly start: number;
  readonly size: number;
}

/**
 * Builds the marquee hit-testing layout for a virtualized single-column
 * list (or tree) of `paths`: rows inside the virtualizer's visible range
 * keep its exact measured position, everything else is extrapolated from
 * `rowHeight`, so a drag can hit-test thousands of rows without any DOM
 * queries. Every row spans the same horizontal span, from `left` for
 * `width`, since list/tree marquee selection does not need per-row
 * horizontal precision.
 */
export function buildListLayout(
  paths: readonly string[],
  measured: readonly VirtualMeasurement[],
  rowHeight: number,
  width: number,
  left = 0,
): LayoutItem[] {
  const byIndex = new Map(measured.map((item) => [item.index, item]));
  return paths.map((path, index) => {
    const exact = byIndex.get(index);
    return {
      path,
      left,
      width,
      top: exact?.start ?? index * rowHeight,
      height: exact?.size ?? rowHeight,
    };
  });
}

/**
 * Builds the marquee hit-testing layout for a virtualized grid of `paths`
 * laid out `columns` tiles per row: rows inside the virtualizer's visible
 * range keep its exact measured vertical position, everything else is
 * extrapolated from `tileHeight`; a tile's horizontal position always comes
 * from its column index and `tileWidth`.
 */
export function buildGridLayout(
  paths: readonly string[],
  measured: readonly VirtualMeasurement[],
  columns: number,
  tileWidth: number,
  tileHeight: number,
): LayoutItem[] {
  const byRowIndex = new Map(measured.map((item) => [item.index, item]));
  return paths.map((path, index) => {
    const rowIndex = Math.floor(index / columns);
    const column = index % columns;
    const exact = byRowIndex.get(rowIndex);
    return {
      path,
      left: column * tileWidth,
      width: tileWidth,
      top: exact?.start ?? rowIndex * tileHeight,
      height: exact?.size ?? tileHeight,
    };
  });
}
