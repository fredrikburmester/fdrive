// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SidebarSection, SidebarSectionLabel } from "./sidebar-section";

const KEY = "fdrive.sidebar.section.tags";

function renderSection() {
  return render(
    <>
      <SidebarSectionLabel>Locations</SidebarSectionLabel>
      <SidebarSection section="tags" label="Tags">
        <a href="/tags/1">Invoices</a>
      </SidebarSection>
    </>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("starts open, and its name shuts and reopens it, remembering the choice", () => {
  renderSection();
  const name = screen.getByRole("button", { name: "Tags" });
  expect(name.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("link", { name: "Invoices" })).toBeTruthy();

  fireEvent.click(name);
  expect(name.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: "Invoices" })).toBeNull();
  expect(localStorage.getItem(KEY)).toBe("false");

  fireEvent.click(name);
  expect(name.getAttribute("aria-expanded")).toBe("true");
  expect(localStorage.getItem(KEY)).toBe("true");
});

it("opens as this browser last left it", () => {
  localStorage.setItem(KEY, "false");
  renderSection();
  expect(screen.getByRole("button", { name: "Tags" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: "Invoices" })).toBeNull();
});

it("labels an always-open section without making its name a button", () => {
  renderSection();
  expect(screen.getByText("Locations")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Locations" })).toBeNull();
});
