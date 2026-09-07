import { describe, expect, it } from "vitest";
import { breadcrumbLayout } from "./breadcrumb-layout";
import type { BreadcrumbEntry } from "./path-url";

function crumb(name: string): BreadcrumbEntry {
  return { name, path: `/${name}`, href: `/files/${name}` };
}

describe("breadcrumbLayout", () => {
  it("returns every crumb uncollapsed on desktop when at or below the threshold", () => {
    const crumbs = [crumb("Home"), crumb("a"), crumb("b"), crumb("c")];
    const layout = breadcrumbLayout(crumbs, false);
    expect(layout).toEqual({ head: crumbs, hidden: [], tail: [], collapsed: false });
  });

  it("collapses the middle on desktop past the threshold, keeping Home and the last two", () => {
    const crumbs = [crumb("Home"), crumb("a"), crumb("b"), crumb("c"), crumb("d")];
    const layout = breadcrumbLayout(crumbs, false);
    expect(layout.collapsed).toBe(true);
    expect(layout.head).toEqual([crumbs[0]]);
    expect(layout.hidden).toEqual([crumbs[1], crumbs[2]]);
    expect(layout.tail).toEqual([crumbs[3], crumbs[4]]);
  });

  it("shows just Home uncollapsed in compact mode at the root", () => {
    const crumbs = [crumb("Home")];
    const layout = breadcrumbLayout(crumbs, true);
    expect(layout).toEqual({ head: crumbs, hidden: [], tail: [], collapsed: false });
  });

  it("truncates from the left in compact mode, keeping only the current folder inline", () => {
    const crumbs = [crumb("Home"), crumb("a"), crumb("b")];
    const layout = breadcrumbLayout(crumbs, true);
    expect(layout.collapsed).toBe(true);
    expect(layout.head).toEqual([]);
    expect(layout.hidden).toEqual([crumbs[0], crumbs[1]]);
    expect(layout.tail).toEqual([crumbs[2]]);
  });

  it("truncates from the left in compact mode even with a single non-root segment", () => {
    const crumbs = [crumb("Home"), crumb("a")];
    const layout = breadcrumbLayout(crumbs, true);
    expect(layout.collapsed).toBe(true);
    expect(layout.hidden).toEqual([crumbs[0]]);
    expect(layout.tail).toEqual([crumbs[1]]);
  });

  it("handles an empty crumb list defensively", () => {
    expect(breadcrumbLayout([], true)).toEqual({
      head: [],
      hidden: [],
      tail: [],
      collapsed: false,
    });
    expect(breadcrumbLayout([], false)).toEqual({
      head: [],
      hidden: [],
      tail: [],
      collapsed: false,
    });
  });
});
