// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRID_TILES } from "./file-grid";
import { ListingSkeleton } from "./listing-skeleton";

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.mobile }));

afterEach(() => {
  cleanup();
  viewport.mobile = false;
});

describe("ListingSkeleton", () => {
  it("renders ten placeholder rows by default", () => {
    const { container } = render(<ListingSkeleton />);
    expect(container.querySelectorAll('[data-slot="skeleton-row"]')).toHaveLength(10);
  });

  it("renders ten placeholder rows for the explicit list variant", () => {
    const { container } = render(<ListingSkeleton variant="list" />);
    expect(container.querySelectorAll('[data-slot="skeleton-row"]')).toHaveLength(10);
  });

  it("gives every row the same height, matching the real list's row height", () => {
    const { container } = render(<ListingSkeleton />);
    const rows = container.querySelectorAll<HTMLElement>('[data-slot="skeleton-row"]');
    const heights = new Set([...rows].map((row) => row.style.height));
    expect(heights.size).toBe(1);
    expect(heights.has("")).toBe(false);
  });

  it("uses the taller two-line rows on a phone, like the real list", () => {
    viewport.mobile = true;
    const heights = (container: HTMLElement) =>
      new Set(
        [...container.querySelectorAll<HTMLElement>('[data-slot="skeleton-row"]')].map(
          (row) => row.style.height,
        ),
      );
    expect(heights(render(<ListingSkeleton />).container)).toEqual(new Set(["56px"]));
    cleanup();
    expect(heights(render(<ListingSkeleton density="comfortable" />).container)).toEqual(
      new Set(["68px"]),
    );
    cleanup();
    expect(heights(render(<ListingSkeleton density="compact" />).container)).toEqual(
      new Set(["48px"]),
    );
  });

  it("sizes each row and its icon stub like the real list at that density", () => {
    const firstRow = (container: HTMLElement) =>
      container.querySelector<HTMLElement>('[data-slot="skeleton-row"]');
    // The stubs in a row: the checkbox, the icon, then the name and columns.
    const iconStub = (container: HTMLElement) =>
      firstRow(container)?.querySelectorAll('[data-slot="skeleton"]')[1]?.className ?? "";

    const comfortable = render(<ListingSkeleton density="comfortable" />);
    expect(firstRow(comfortable.container)?.style.height).toBe("64px");
    expect(iconStub(comfortable.container)).toContain("size-10");
    cleanup();

    const standard = render(<ListingSkeleton />);
    expect(firstRow(standard.container)?.style.height).toBe("36px");
    expect(iconStub(standard.container)).toContain("size-4");
    cleanup();

    const compact = render(<ListingSkeleton density="compact" />);
    expect(firstRow(compact.container)?.style.height).toBe("30px");
    expect(iconStub(compact.container)).toContain("size-4");
    cleanup();

    viewport.mobile = true;
    expect(iconStub(render(<ListingSkeleton density="comfortable" />).container)).toContain(
      "size-10",
    );
    cleanup();
    expect(iconStub(render(<ListingSkeleton />).container)).toContain("size-8");
    cleanup();
    expect(iconStub(render(<ListingSkeleton density="compact" />).container)).toContain("size-7");
  });

  it("never sets a fixed pixel width on a row or its stubs, so rows fill the listing area", () => {
    const { container } = render(<ListingSkeleton />);
    const rows = container.querySelectorAll<HTMLElement>('[data-slot="skeleton-row"]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.style.width).toBe("");
      for (const child of row.querySelectorAll<HTMLElement>("*")) {
        expect(child.style.width).toBe("");
      }
    }
  });

  it("renders placeholder tiles for the grid variant, sized like a real grid tile", () => {
    const { container } = render(<ListingSkeleton variant="grid" />);
    const tiles = container.querySelectorAll<HTMLElement>('[data-slot="skeleton-tile"]');
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.style.width).not.toBe("");
      expect(tile.style.height).not.toBe("");
    }
  });

  it("sizes grid placeholder tiles like the chosen grid size", () => {
    const { container, rerender } = render(<ListingSkeleton variant="grid" />);
    const firstTile = () =>
      container.querySelector<HTMLElement>('[data-slot="skeleton-tile"]')?.style.width;
    expect(firstTile()).toBe(`${GRID_TILES.medium.width}px`);
    rerender(<ListingSkeleton variant="grid" gridSize="large" />);
    expect(firstTile()).toBe(`${GRID_TILES.large.width}px`);
  });
});
