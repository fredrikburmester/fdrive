import { describe, expect, it } from "vitest";
import {
  autoScrollSpeed,
  buildGridLayout,
  buildListLayout,
  type ClosestElementLike,
  isMarqueeStartTarget,
  itemsInRect,
  type LayoutItem,
  marqueeSelection,
  passesDragThreshold,
  rectFromPoints,
} from "./marquee";

describe("rectFromPoints", () => {
  it("normalizes when the drag moves down and to the right", () => {
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 50, y: 80 })).toEqual({
      left: 10,
      top: 20,
      right: 50,
      bottom: 80,
    });
  });

  it("normalizes when the drag moves up and to the left", () => {
    expect(rectFromPoints({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({
      left: 10,
      top: 20,
      right: 50,
      bottom: 80,
    });
  });
});

describe("itemsInRect", () => {
  const rows: LayoutItem[] = [
    { path: "/a", top: 0, left: 0, width: 300, height: 36 },
    { path: "/b", top: 36, left: 0, width: 300, height: 36 },
    { path: "/c", top: 72, left: 0, width: 300, height: 36 },
  ];

  it("selects rows fully inside the rect", () => {
    expect(itemsInRect({ left: 0, top: 0, right: 300, bottom: 72 }, rows)).toEqual(["/a", "/b"]);
  });

  it("selects a row only partially overlapped by the rect", () => {
    // Rect covers only the bottom half of row /a and the top half of /b.
    expect(itemsInRect({ left: 0, top: 18, right: 300, bottom: 54 }, rows)).toEqual(["/a", "/b"]);
  });

  it("excludes rows the rect does not reach", () => {
    expect(itemsInRect({ left: 0, top: 0, right: 300, bottom: 10 }, rows)).toEqual(["/a"]);
  });

  it("does not count an edge that only touches, with no overlapping area", () => {
    expect(itemsInRect({ left: 0, top: 36, right: 300, bottom: 36 }, rows)).toEqual([]);
  });

  it("hit-tests grid tiles by both axes", () => {
    const tiles: LayoutItem[] = [
      { path: "/t1", top: 0, left: 0, width: 100, height: 100 },
      { path: "/t2", top: 0, left: 100, width: 100, height: 100 },
      { path: "/t3", top: 100, left: 0, width: 100, height: 100 },
    ];
    // A rect over the top-left corner only reaches /t1.
    expect(itemsInRect({ left: 0, top: 0, right: 50, bottom: 50 }, tiles)).toEqual(["/t1"]);
    // A rect spanning the top row's boundary reaches /t1 and /t2 but not /t3.
    expect(itemsInRect({ left: 0, top: 0, right: 150, bottom: 50 }, tiles)).toEqual(["/t1", "/t2"]);
  });

  it("returns an empty array when nothing overlaps", () => {
    expect(itemsInRect({ left: 400, top: 400, right: 500, bottom: 500 }, rows)).toEqual([]);
  });
});

describe("passesDragThreshold", () => {
  it("is false for movement under the threshold", () => {
    expect(passesDragThreshold({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
  });

  it("is true once movement reaches the default 4px threshold", () => {
    expect(passesDragThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(passesDragThreshold({ x: 0, y: 0 }, { x: 8, y: 0 }, 10)).toBe(false);
    expect(passesDragThreshold({ x: 0, y: 0 }, { x: 12, y: 0 }, 10)).toBe(true);
  });
});

describe("autoScrollSpeed", () => {
  it("is 0 in the middle of the container", () => {
    expect(autoScrollSpeed(300, 100, 400)).toBe(0);
  });

  it("scrolls up (negative) near the top edge", () => {
    const speed = autoScrollSpeed(105, 100, 400);
    expect(speed).toBeLessThan(0);
  });

  it("scrolls down (positive) near the bottom edge", () => {
    const speed = autoScrollSpeed(495, 100, 400);
    expect(speed).toBeGreaterThan(0);
  });

  it("reaches max speed right at the edge", () => {
    expect(autoScrollSpeed(100, 100, 400)).toBe(-16);
    expect(autoScrollSpeed(500, 100, 400)).toBe(16);
  });

  it("clamps to max speed past the edge", () => {
    expect(autoScrollSpeed(80, 100, 400)).toBe(-16);
    expect(autoScrollSpeed(520, 100, 400)).toBe(16);
  });

  it("respects custom edge size and max speed", () => {
    expect(autoScrollSpeed(110, 100, 400, 12, 8)).toBeCloseTo((-8 * (12 - 10)) / 12);
  });
});

describe("marqueeSelection", () => {
  it("replaces the selection outright in replace mode", () => {
    expect(marqueeSelection(["/old"], ["/a", "/b"], "replace")).toEqual(["/a", "/b"]);
  });

  it("unions with the base selection in add mode, preserving base order first", () => {
    expect(marqueeSelection(["/old"], ["/a", "/old"], "add")).toEqual(["/old", "/a"]);
  });

  it("does not duplicate an already-covered base entry", () => {
    expect(marqueeSelection(["/a", "/b"], ["/b", "/c"], "add")).toEqual(["/a", "/b", "/c"]);
  });
});

describe("isMarqueeStartTarget", () => {
  /** A fake DOM node whose `closest` only ever matches `[data-path]`, never
   * `[data-marquee-exclude]`, resolving to `row` (or itself, when `row` is
   * omitted) for that one selector and `null` for everything else. */
  function rowLikeTarget(row?: ClosestElementLike): ClosestElementLike {
    const self: ClosestElementLike = {
      closest: (selector) => (selector === "[data-path]" ? (row ?? self) : null),
    };
    return self;
  }

  it("is true when there is no target at all", () => {
    expect(isMarqueeStartTarget(null)).toBe(true);
  });

  it("is true when the target has no [data-path] ancestor", () => {
    const outsideAnyRow: ClosestElementLike = { closest: () => null };
    expect(isMarqueeStartTarget(outsideAnyRow)).toBe(true);
  });

  it("is true when the target is the row's own background", () => {
    // closest() called on the row itself returns the row: target === row.
    expect(isMarqueeStartTarget(rowLikeTarget())).toBe(true);
  });

  it("is false when the target is content inside a row", () => {
    const row = rowLikeTarget();
    const content = rowLikeTarget(row);
    expect(isMarqueeStartTarget(content)).toBe(false);
  });

  it("is false under a [data-marquee-exclude] ancestor, even with no [data-path] ancestor", () => {
    const excluded: ClosestElementLike = {
      closest: (selector) => (selector === "[data-marquee-exclude]" ? excluded : null),
    };
    expect(isMarqueeStartTarget(excluded)).toBe(false);
  });
});

describe("buildListLayout", () => {
  it("uses the virtualizer's exact measurement inside the visible range", () => {
    const layout = buildListLayout(
      ["/a", "/b", "/c"],
      [
        { index: 0, start: 0, size: 40 },
        { index: 1, start: 40, size: 40 },
      ],
      36,
      300,
    );
    expect(layout[0]).toEqual({ path: "/a", left: 0, width: 300, top: 0, height: 40 });
    expect(layout[1]).toEqual({ path: "/b", left: 0, width: 300, top: 40, height: 40 });
  });

  it("extrapolates from rowHeight for items outside the visible range", () => {
    const layout = buildListLayout(["/a", "/b", "/c"], [], 36, 300);
    expect(layout[2]).toEqual({ path: "/c", left: 0, width: 300, top: 72, height: 36 });
  });
});

describe("buildGridLayout", () => {
  it("positions tiles by column and uses the measured row for height", () => {
    const layout = buildGridLayout(
      ["/a", "/b", "/c", "/d"],
      [{ index: 0, start: 0, size: 110 }],
      2,
      112,
      104,
    );
    expect(layout[0]).toEqual({ path: "/a", left: 0, width: 112, top: 0, height: 110 });
    expect(layout[1]).toEqual({ path: "/b", left: 112, width: 112, top: 0, height: 110 });
    // Row index 1 (tiles /c, /d) is not measured, so it is extrapolated.
    expect(layout[2]).toEqual({ path: "/c", left: 0, width: 112, top: 104, height: 104 });
    expect(layout[3]).toEqual({ path: "/d", left: 112, width: 112, top: 104, height: 104 });
  });
});
