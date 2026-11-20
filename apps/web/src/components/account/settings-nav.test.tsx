// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SETTINGS_SECTIONS } from "./sections";
import { SettingsNav } from "./settings-nav";

afterEach(cleanup);

it("links every section to its own URL, in order", () => {
  render(<SettingsNav sections={SETTINGS_SECTIONS} currentId="appearance" />);
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  const links = within(nav).getAllByRole("link");

  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/account/appearance",
    "/account/browsing",
    "/account/formats",
    "/account/password",
    "/account/encryption",
    "/account/tokens",
  ]);
});

it("marks only the open section as the current page", () => {
  render(<SettingsNav sections={SETTINGS_SECTIONS} currentId="formats" />);

  const current = screen.getByRole("link", { name: "Formats" });
  expect(current.getAttribute("aria-current")).toBe("page");
  expect(current.hasAttribute("data-active")).toBe(true);
  for (const name of ["Appearance", "Browsing", "Password", "Encryption", "API tokens"]) {
    const link = screen.getByRole("link", { name });
    expect(link.getAttribute("aria-current")).toBeNull();
    expect(link.hasAttribute("data-active")).toBe(false);
  }
});

it("names a section by its label and describes it with its one-line summary", () => {
  render(<SettingsNav sections={SETTINGS_SECTIONS} currentId="appearance" />);

  const link = screen.getByRole("link", { name: "API tokens" });
  const description = document.getElementById(link.getAttribute("aria-describedby") ?? "");
  expect(description?.textContent).toBe("Tokens for Claude and Raycast");
});

it("lists only the sections it is given", () => {
  render(
    <SettingsNav
      sections={SETTINGS_SECTIONS.filter((section) => section.id !== "encryption")}
      currentId="appearance"
      className="max-md:hidden"
    />,
  );

  expect(screen.queryByRole("link", { name: "Encryption" })).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(5);
  expect(screen.getByRole("navigation").classList.contains("max-md:hidden")).toBe(true);
});
