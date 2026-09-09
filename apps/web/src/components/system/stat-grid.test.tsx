// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatGrid } from "./stat-grid";

afterEach(cleanup);

describe("StatGrid", () => {
  it("renders one card per stat, with its hint", () => {
    render(
      <StatGrid
        stats={[
          { label: "Files", value: "10" },
          { label: "Chunks", value: "20", hint: "Across every root." },
        ]}
      />,
    );

    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.getByText("Chunks")).toBeTruthy();
    expect(screen.getByText("Across every root.")).toBeTruthy();
  });

  it("caps its widest column count at five and honours an explicit one", () => {
    const { container } = render(
      <StatGrid
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
    expect(container.firstElementChild?.className).toContain("lg:grid-cols-5");

    cleanup();
    const explicit = render(<StatGrid stats={[{ label: "A", value: 1 }]} columns={4} />);
    expect(explicit.container.firstElementChild?.className).toContain("md:grid-cols-4");
  });
});
