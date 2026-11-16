import { describe, expect, it } from "vitest";
import { type BreadcrumbWidths, breadcrumbLayout } from "./breadcrumb-layout";
import type { BreadcrumbEntry } from "./path-url";

function crumb(name: string): BreadcrumbEntry {
  return { name, path: `/${name}`, href: `/files/${name}` };
}

/** Widths for a trail whose names are `names` wide, each followed by a
 * 20px separator except the last. */
function widths(available: number, names: readonly number[]): BreadcrumbWidths {
  return {
    available,
    crumbs: names.map((name, index) => ({ name, trailing: index < names.length - 1 ? 20 : 0 })),
    ellipsis: 40,
  };
}

describe("breadcrumbLayout", () => {
  // Natural width: 440 for the names plus 80 for separators.
  const five = [crumb("Home"), crumb("a"), crumb("b"), crumb("c"), crumb("d")];
  const fiveNames = [40, 100, 100, 100, 100];

  it("returns every crumb at its natural width on desktop before the trail is measured", () => {
    const whole = { head: five, hidden: [], tail: [], collapsed: false, nameMaxWidth: null };
    expect(breadcrumbLayout(five)).toEqual(whole);
    expect(breadcrumbLayout(five, null)).toEqual(whole);
  });

  it("keeps a long trail whole and untruncated on desktop while it fits", () => {
    expect(breadcrumbLayout(five, widths(520, fiveNames))).toEqual({
      head: five,
      hidden: [],
      tail: [],
      collapsed: false,
      nameMaxWidth: null,
    });
  });

  it("truncates the longest names evenly before hiding any ancestor", () => {
    // 400px for names: Home keeps its 40, the other four share 360.
    const layout = breadcrumbLayout(five, widths(480, fiveNames));
    expect(layout).toEqual({
      head: five,
      hidden: [],
      tail: [],
      collapsed: false,
      nameMaxWidth: 90,
    });
  });

  it("hides the shallowest ancestor once names would get too narrow to read", () => {
    const layout = breadcrumbLayout(five, widths(400, fiveNames));
    expect(layout.collapsed).toBe(true);
    expect(layout.head).toEqual([five[0]]);
    expect(layout.hidden).toEqual([five[1]]);
    expect(layout.tail).toEqual([five[2], five[3], five[4]]);
    expect(layout.nameMaxWidth).toBeCloseTo(86.67, 1);
  });

  it("hides more ancestors as the width shrinks, keeping Home and the deepest folders", () => {
    const layout = breadcrumbLayout(five, widths(300, fiveNames));
    expect(layout.head).toEqual([five[0]]);
    expect(layout.hidden).toEqual([five[1], five[2]]);
    expect(layout.tail).toEqual([five[3], five[4]]);
    expect(layout.nameMaxWidth).toBe(90);
  });

  it("drops truncation once hiding ancestors leaves room for whole names", () => {
    const layout = breadcrumbLayout(five, widths(260, fiveNames));
    expect(layout.hidden).toEqual([five[1], five[2], five[3]]);
    expect(layout.tail).toEqual([five[4]]);
    expect(layout.nameMaxWidth).toBeNull();
  });

  it("hides Home too once even Home and the current folder alone are too tight", () => {
    expect(breadcrumbLayout(five, widths(100, fiveNames))).toEqual({
      head: [],
      hidden: [five[0], five[1], five[2], five[3]],
      tail: [five[4]],
      collapsed: true,
      nameMaxWidth: null,
    });
  });

  it("truncates Home and the current folder alone before hiding Home", () => {
    const crumbs = [crumb("Home"), crumb("a")];
    expect(breadcrumbLayout(crumbs, widths(200, [40, 300]))).toEqual({
      head: crumbs,
      hidden: [],
      tail: [],
      collapsed: false,
      nameMaxWidth: 140,
    });
    expect(breadcrumbLayout(crumbs, widths(100, [40, 300]))).toEqual({
      head: [],
      hidden: [crumbs[0]],
      tail: [crumbs[1]],
      collapsed: true,
      nameMaxWidth: null,
    });
  });

  it("keeps Home whole at the root however narrow the trail is", () => {
    const crumbs = [crumb("Home")];
    expect(breadcrumbLayout(crumbs, widths(10, [40]))).toEqual({
      head: crumbs,
      hidden: [],
      tail: [],
      collapsed: false,
      nameMaxWidth: 10,
    });
  });

  it("handles an empty crumb list defensively", () => {
    const empty = { head: [], hidden: [], tail: [], collapsed: false, nameMaxWidth: null };
    expect(breadcrumbLayout([])).toEqual(empty);
    expect(breadcrumbLayout([], widths(100, []))).toEqual(empty);
  });
});
