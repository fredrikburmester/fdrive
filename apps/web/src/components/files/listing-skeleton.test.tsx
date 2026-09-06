// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ListingSkeleton } from "./listing-skeleton";

afterEach(cleanup);

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
});
