// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Moon, Sun } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChoiceRow, SegmentedControl } from "./setting-controls";

afterEach(cleanup);

type Meal = "breakfast" | "lunch" | "dinner";
const MEALS: readonly Meal[] = ["breakfast", "lunch", "dinner"];
const MEAL_LABELS: Record<Meal, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
};

describe("SegmentedControl", () => {
  it("names the group and presses only the chosen segment", () => {
    render(
      <SegmentedControl
        label="Meal"
        value="lunch"
        options={MEALS}
        labels={MEAL_LABELS}
        onChange={vi.fn()}
      />,
    );

    const group = screen.getByRole("group", { name: "Meal" });
    const segments = within(group).getAllByRole("button");
    expect(segments.map((segment) => segment.textContent)).toEqual([
      "Breakfast",
      "Lunch",
      "Dinner",
    ]);
    expect(segments.map((segment) => segment.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("reports another segment, and nothing when the chosen one is pressed again", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Meal"
        value="lunch"
        options={MEALS}
        labels={MEAL_LABELS}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Lunch" }));
    expect(onChange).not.toHaveBeenCalled();
    // The value is the caller's: it stays pressed until the caller changes it.
    expect(screen.getByRole("button", { name: "Lunch" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Dinner" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("dinner");
  });

  it("puts an icon ahead of a label without changing the segment's name", () => {
    render(
      <SegmentedControl
        label="Meal"
        value="breakfast"
        options={MEALS}
        labels={MEAL_LABELS}
        icons={{ breakfast: Sun, dinner: Moon }}
        onChange={vi.fn()}
      />,
    );

    const breakfast = screen.getByRole("button", { name: "Breakfast" });
    expect(breakfast.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "Lunch" }).querySelector("svg")).toBeNull();
    expect(screen.getByRole("button", { name: "Dinner" }).querySelector("svg")).not.toBeNull();
  });
});

describe("ChoiceRow", () => {
  it("shows the setting's label and hint beside its segments", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ChoiceRow
        label="Meal"
        hint="Eaten at noon."
        value="lunch"
        options={MEALS}
        labels={MEAL_LABELS}
        onChange={onChange}
      />,
    );

    const row = container.querySelector('[data-slot="setting-row"]') as HTMLElement;
    expect(within(row).getByText("Meal")).toBeDefined();
    expect(within(row).getByText("Eaten at noon.")).toBeDefined();
    fireEvent.click(within(row).getByRole("button", { name: "Breakfast" }));
    expect(onChange).toHaveBeenCalledWith("breakfast");
  });
});
