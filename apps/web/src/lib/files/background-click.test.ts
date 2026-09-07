import { describe, expect, it } from "vitest";
import { type ClosestElementLike, isBackgroundClick } from "./background-click";

/** A fake DOM node whose `closest` only ever matches `[data-path]`, never
 * `[data-selection-exclude]`, resolving to `row` (or itself, when `row` is
 * omitted) for that one selector and `null` for everything else. */
function rowLikeTarget(row?: ClosestElementLike): ClosestElementLike {
  const self: ClosestElementLike = {
    closest: (selector) => (selector === "[data-path]" ? (row ?? self) : null),
  };
  return self;
}

describe("isBackgroundClick", () => {
  it("is true when there is no target at all", () => {
    expect(isBackgroundClick(null)).toBe(true);
  });

  it("is true when the target has no [data-path] ancestor", () => {
    const outsideAnyRow: ClosestElementLike = { closest: () => null };
    expect(isBackgroundClick(outsideAnyRow)).toBe(true);
  });

  it("is false when the target is a row's own background, unlike the old marquee predicate", () => {
    // closest() called on the row itself returns the row: target === row.
    // This is the deliberate difference from `isMarqueeStartTarget`: the
    // row already selects itself via its own onClick, so this must not
    // read as background and clear that selection right back out.
    expect(isBackgroundClick(rowLikeTarget())).toBe(false);
  });

  it("is false when the target is content inside a row", () => {
    const row = rowLikeTarget();
    const content = rowLikeTarget(row);
    expect(isBackgroundClick(content)).toBe(false);
  });

  it("is false under a [data-selection-exclude] ancestor, even with no [data-path] ancestor", () => {
    const excluded: ClosestElementLike = {
      closest: (selector) => (selector === "[data-selection-exclude]" ? excluded : null),
    };
    expect(isBackgroundClick(excluded)).toBe(false);
  });
});
