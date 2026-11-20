// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  theme: undefined as string | undefined,
  setTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: mocks.theme, setTheme: mocks.setTheme }),
}));

const { AppearanceSection } = await import("./appearance-section");

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  mocks.theme = undefined;
});

function option(group: string, name: string) {
  return within(screen.getByRole("group", { name: group })).getByRole("button", { name });
}

function pressed(group: string, name: string) {
  return option(group, name).getAttribute("aria-pressed");
}

it("shows the stored theme and sets another", () => {
  mocks.theme = "dark";
  render(<AppearanceSection />);

  // The section is its own sheet, and its name is the page's heading.
  const sheet = screen.getByRole("region", { name: "Appearance" });
  expect(within(sheet).getByRole("heading", { level: 1, name: "Appearance" })).toBeDefined();
  expect(within(sheet).getByText("How fdrive looks in this browser.")).toBeDefined();
  expect(within(sheet).getByRole("group", { name: "Theme" })).toBeDefined();
  expect(pressed("Theme", "Dark")).toBe("true");
  expect(pressed("Theme", "Light")).toBe("false");
  expect(pressed("Theme", "System")).toBe("false");
  expect(screen.getByText("Dark at any time of day.")).toBeDefined();

  fireEvent.click(option("Theme", "Light"));
  expect(mocks.setTheme).toHaveBeenCalledTimes(1);
  expect(mocks.setTheme).toHaveBeenCalledWith("light");
});

it("explains each theme", () => {
  mocks.theme = "light";
  const view = render(<AppearanceSection />);
  expect(screen.getByText("Light at any time of day.")).toBeDefined();

  mocks.theme = "system";
  view.rerender(<AppearanceSection />);
  expect(pressed("Theme", "System")).toBe("true");
  expect(screen.getByText("Light or dark, following this device.")).toBeDefined();
});

it("shows System until a theme is stored, and for one it does not know", () => {
  const view = render(<AppearanceSection />);
  expect(pressed("Theme", "System")).toBe("true");

  mocks.theme = "sepia";
  view.rerender(<AppearanceSection />);
  expect(pressed("Theme", "System")).toBe("true");
  expect(pressed("Theme", "Dark")).toBe("false");
});

it("keeps the theme when its own segment is pressed again", () => {
  mocks.theme = "dark";
  render(<AppearanceSection />);

  fireEvent.click(option("Theme", "Dark"));
  expect(mocks.setTheme).not.toHaveBeenCalled();
  expect(pressed("Theme", "Dark")).toBe("true");
});

it("renders System on the server, whatever this browser has stored", async () => {
  const { renderToString } = await import("react-dom/server");
  mocks.theme = "dark";
  const html = renderToString(<AppearanceSection />);
  const page = new DOMParser().parseFromString(html, "text/html");

  const segments = page.querySelectorAll('[role="group"][aria-label="Theme"] button');
  expect(
    Array.from(segments, (segment) => [segment.textContent, segment.getAttribute("aria-pressed")]),
  ).toEqual([
    ["Light", "false"],
    ["Dark", "false"],
    ["System", "true"],
  ]);
});

it("switches the file list between the classic and the beta design", () => {
  render(<AppearanceSection />);
  expect(pressed("File list", "Classic")).toBe("true");
  expect(screen.getByText(/Every row has a checkbox/)).toBeDefined();

  fireEvent.click(option("File list", "New (beta)"));
  expect(pressed("File list", "New (beta)")).toBe("true");
  expect(pressed("File list", "Classic")).toBe("false");
  expect(screen.getByText(/Folders open in place/)).toBeDefined();
  expect(localStorage.getItem("fdrive.list.design")).toBe('"beta"');
});

it("shows the stored file list design on mount", () => {
  localStorage.setItem("fdrive.list.design", '"beta"');
  render(<AppearanceSection />);
  expect(pressed("File list", "New (beta)")).toBe("true");
});
