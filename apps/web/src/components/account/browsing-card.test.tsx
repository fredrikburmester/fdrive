// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BrowsingCard } from "./browsing-card";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function pressed(name: string) {
  return screen.getByRole("button", { name }).getAttribute("aria-pressed");
}

it("defaults to Select and persists the chosen row-click action", () => {
  render(<BrowsingCard />);
  expect(pressed("Select")).toBe("true");
  expect(screen.getByText(/A click selects just that item/)).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(pressed("Open")).toBe("true");
  expect(pressed("Select")).toBe("false");
  expect(screen.getByText(/A click opens the item/)).toBeDefined();
  expect(localStorage.getItem("fdrive.list.rowClick")).toBe('"open"');
});

it("shows the stored action on mount", () => {
  localStorage.setItem("fdrive.list.rowClick", '"toggle"');
  render(<BrowsingCard />);
  expect(pressed("Toggle selection")).toBe("true");
  expect(screen.getByText(/adds or removes the item/)).toBeDefined();
});

it("offers highlight as a row-click action", () => {
  render(<BrowsingCard />);
  fireEvent.click(screen.getByRole("button", { name: "Highlight" }));
  expect(pressed("Highlight")).toBe("true");
  expect(screen.getByText(/outlines the item without selecting it/)).toBeDefined();
  expect(localStorage.getItem("fdrive.list.rowClick")).toBe('"highlight"');
});

it("persists size, date and clock choices under their own keys", () => {
  render(<BrowsingCard />);
  expect(pressed("Binary")).toBe("true");
  expect(pressed("Relative")).toBe("true");
  expect(pressed("24-hour")).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: "Decimal" }));
  fireEvent.click(screen.getByRole("button", { name: "Absolute" }));
  fireEvent.click(screen.getByRole("button", { name: "12-hour" }));
  expect(pressed("Decimal")).toBe("true");
  expect(screen.getByText(/1,000 bytes per kB/)).toBeDefined();
  expect(screen.getByText(/Every change shows its date and time/)).toBeDefined();
  expect(screen.getByText(/9:05 PM/)).toBeDefined();
  expect(localStorage.getItem("fdrive.format.sizes")).toBe('"decimal"');
  expect(localStorage.getItem("fdrive.format.dates")).toBe('"absolute"');
  expect(localStorage.getItem("fdrive.format.clock")).toBe('"12h"');
  expect(localStorage.getItem("fdrive.list.rowClick")).toBeNull();
});
