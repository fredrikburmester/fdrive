// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

// The section's own tests cover it; here only which section each route shows.
vi.mock("@/components/account/appearance-section", () => ({
  AppearanceSection: () => <p>Appearance section</p>,
}));

const { default: Settings, metadata } = await import("./page");
const { default: SettingsAppearance, metadata: appearanceMetadata } = await import(
  "./appearance/page"
);

afterEach(cleanup);

it("opens the first section on /account itself, under the Settings title", () => {
  render(<Settings />);

  expect(screen.getByText("Appearance section")).toBeDefined();
  expect(metadata.title).toBe("Settings - fdrive");
});

it("opens the same section at its own URL", () => {
  render(<SettingsAppearance />);

  expect(screen.getByText("Appearance section")).toBeDefined();
  expect(appearanceMetadata.title).toBe("Appearance - fdrive");
});
