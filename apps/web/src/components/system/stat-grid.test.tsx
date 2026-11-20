// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatGrid } from "./stat-grid";

afterEach(cleanup);

describe("StatGrid", () => {
  it("renders one number per stat over its label, with its hint", () => {
    render(
      <StatGrid
        stats={[
          { label: "Files", value: "10" },
          { label: "Chunks", value: "20", hint: "Across every root." },
        ]}
      />,
    );

    // Each stat is a term with its number as the description, so the pair is read together.
    const files = screen.getByText("Files");
    expect(files.tagName).toBe("DT");
    expect(files.parentElement?.querySelector("dd")?.textContent).toBe("10");
    const chunks = screen.getByText("Chunks").parentElement as HTMLElement;
    expect(Array.from(chunks.querySelectorAll("dd")).map((dd) => dd.textContent)).toEqual([
      "20",
      "Across every root.",
    ]);
    expect(files.parentElement?.querySelectorAll("dd")).toHaveLength(1);
  });

  it("is one row that wraps, however many numbers it holds", () => {
    const { container } = render(
      <StatGrid
        className="mt-2"
        stats={[
          { label: "A", value: 1 },
          { label: "B", value: 2 },
          { label: "C", value: 3 },
          { label: "D", value: 4 },
          { label: "E", value: 5 },
          { label: "F", value: 6 },
        ]}
      />,
    );

    const grid = container.firstElementChild as HTMLElement;
    expect(grid.tagName).toBe("DL");
    expect(grid.dataset.slot).toBe("stat-grid");
    expect(grid.querySelectorAll('[data-slot="stat"]')).toHaveLength(6);
    // The columns fit themselves to the sheet: no count is fixed at any width.
    expect(grid.className).toContain("auto-fit");
    expect(grid.className).not.toMatch(/grid-cols-\d/);
    expect(grid.className).toContain("mt-2");
  });
});
