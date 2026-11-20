// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reset: { mutate: vi.fn(), isPending: false },
}));

vi.mock("@/lib/files/folder-view-queries", () => ({ useResetFolderViews: () => mocks.reset }));

const { BrowsingSection } = await import("./browsing-section");

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  mocks.reset = { mutate: vi.fn(), isPending: false };
});

function option(group: string, name: string) {
  return within(screen.getByRole("group", { name: group })).getByRole("button", { name });
}

function pressed(group: string, name: string) {
  return option(group, name).getAttribute("aria-pressed");
}

it("defaults to Select and persists the chosen row-click action", () => {
  render(<BrowsingSection />);
  expect(pressed("Row click", "Select")).toBe("true");
  expect(screen.getByText(/A click selects just that item/)).toBeDefined();

  fireEvent.click(option("Row click", "Open"));
  expect(pressed("Row click", "Open")).toBe("true");
  expect(pressed("Row click", "Select")).toBe("false");
  expect(screen.getByText(/A click opens the item/)).toBeDefined();
  expect(localStorage.getItem("fdrive.list.rowClick")).toBe('"open"');
});

it("shows the stored action on mount", () => {
  localStorage.setItem("fdrive.list.rowClick", '"toggle"');
  render(<BrowsingSection />);
  expect(pressed("Row click", "Toggle selection")).toBe("true");
  expect(screen.getByText(/adds or removes the item/)).toBeDefined();
});

it("offers highlight as a row-click action", () => {
  render(<BrowsingSection />);
  fireEvent.click(option("Row click", "Highlight"));
  expect(pressed("Row click", "Highlight")).toBe("true");
  expect(screen.getByText(/outlines the item without selecting it/)).toBeDefined();
  expect(localStorage.getItem("fdrive.list.rowClick")).toBe('"highlight"');
});

it("keeps the row-click action when its own segment is pressed again", () => {
  render(<BrowsingSection />);
  fireEvent.click(option("Row click", "Select"));
  expect(pressed("Row click", "Select")).toBe("true");
  expect(localStorage.getItem("fdrive.list.rowClick")).toBeNull();
});

it("sets the default view for this browser", () => {
  render(<BrowsingSection />);
  expect(screen.getByRole("heading", { level: 2, name: "Folder views" })).toBeDefined();
  expect(pressed("Default view", "List")).toBe("true");
  expect(screen.getByText(/folders without a saved view and for virtual listings/)).toBeDefined();

  fireEvent.click(option("Default view", "Grid"));
  expect(pressed("Default view", "Grid")).toBe("true");
  expect(pressed("Default view", "List")).toBe("false");
  expect(localStorage.getItem("fdrive.view")).toBe('"grid"');

  fireEvent.click(option("Default view", "Tree"));
  expect(pressed("Default view", "Tree")).toBe("true");
  expect(localStorage.getItem("fdrive.view")).toBe('"tree"');
});

it("starts the default view as a tree with the beta file list", () => {
  localStorage.setItem("fdrive.list.design", '"beta"');
  render(<BrowsingSection />);
  expect(pressed("Default view", "Tree")).toBe("true");
});

it("resets every saved folder view, and says so while it runs", () => {
  const view = render(<BrowsingSection />);
  expect(screen.getByText(/Remove every saved view and sort/)).toBeDefined();
  const reset = screen.getByRole("button", { name: "Reset all folder views" }) as HTMLButtonElement;
  expect(reset.disabled).toBe(false);

  fireEvent.click(reset);
  expect(mocks.reset.mutate).toHaveBeenCalledTimes(1);

  mocks.reset = { ...mocks.reset, isPending: true };
  view.rerender(<BrowsingSection />);
  const busy = screen.getByRole("button", { name: "Resetting…" }) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
});
