// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FormatsSection } from "./formats-section";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function option(group: string, name: string) {
  return within(screen.getByRole("group", { name: group })).getByRole("button", { name });
}

function pressed(group: string, name: string) {
  return option(group, name).getAttribute("aria-pressed");
}

it("starts with binary sizes, relative dates and a 24-hour clock", () => {
  render(<FormatsSection />);
  // The section is its own sheet, and its name is the page's heading.
  const sheet = screen.getByRole("region", { name: "Formats" });
  expect(within(sheet).getByRole("heading", { level: 1, name: "Formats" })).toBeDefined();
  expect(within(sheet).getByText("How sizes, dates and times read in this browser.")).toBeDefined();
  expect(within(sheet).getAllByRole("group")).toHaveLength(3);
  expect(pressed("Sizes", "Binary")).toBe("true");
  expect(pressed("Dates", "Relative")).toBe("true");
  expect(pressed("Time", "24-hour")).toBe("true");
  expect(screen.getByText(/1,024 bytes per KB/)).toBeDefined();
  expect(screen.getByText(/Today or Yesterday/)).toBeDefined();
  expect(screen.getByText(/21:05/)).toBeDefined();
});

it("persists size, date and clock choices under their own keys", () => {
  render(<FormatsSection />);

  fireEvent.click(option("Sizes", "Decimal"));
  fireEvent.click(option("Dates", "Absolute"));
  fireEvent.click(option("Time", "12-hour"));
  expect(pressed("Sizes", "Decimal")).toBe("true");
  expect(pressed("Sizes", "Binary")).toBe("false");
  expect(pressed("Dates", "Absolute")).toBe("true");
  expect(pressed("Time", "12-hour")).toBe("true");
  expect(screen.getByText(/1,000 bytes per kB/)).toBeDefined();
  expect(screen.getByText(/Every change shows its date and time/)).toBeDefined();
  expect(screen.getByText(/9:05 PM/)).toBeDefined();
  expect(localStorage.getItem("fdrive.format.sizes")).toBe('"decimal"');
  expect(localStorage.getItem("fdrive.format.dates")).toBe('"absolute"');
  expect(localStorage.getItem("fdrive.format.clock")).toBe('"12h"');
  expect(localStorage.getItem("fdrive.list.rowClick")).toBeNull();
});

it("shows the stored choices on mount", () => {
  localStorage.setItem("fdrive.format.sizes", '"decimal"');
  localStorage.setItem("fdrive.format.clock", '"12h"');
  render(<FormatsSection />);
  expect(pressed("Sizes", "Decimal")).toBe("true");
  expect(pressed("Dates", "Relative")).toBe("true");
  expect(pressed("Time", "12-hour")).toBe("true");
});
