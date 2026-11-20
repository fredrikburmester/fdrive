// @vitest-environment jsdom
import type { AboutResponse } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isAdmin: false, about: vi.fn<() => Promise<AboutResponse>>() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/lib/api/server", () => ({
  serverApiClient: async () => ({
    about: mocks.about,
    me: async () => ({ userId: "fixture", isAdmin: mocks.isAdmin }),
  }),
}));
// The header needs the shell's sidebar and query providers; its own tests cover it.
vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => null }));

import AboutPage from "./page";

const revision = "0123456789abcdef0123456789abcdef01234567";

beforeEach(() => {
  mocks.isAdmin = false;
  mocks.about.mockReset();
  mocks.about.mockResolvedValue({
    version: revision,
    release: "0.1.0",
    revision,
    uptimeSeconds: 90,
    setupRequired: false,
  });
});
afterEach(cleanup);

it("shows About as the whole page to someone who is not an administrator", async () => {
  render(await AboutPage());

  const sheet = screen.getByRole("region", { name: "About fdrive" });
  expect(sheet.getAttribute("data-slot")).toBe("detail-sheet");
  expect(screen.getByRole("heading", { level: 1, name: "About fdrive" })).toBeTruthy();
  // The running API, read on the server for this render.
  expect(screen.getByText("Version").nextElementSibling?.textContent).toBe("0.1.0");
  expect(screen.getByRole("link", { name: revision.slice(0, 12) }).getAttribute("href")).toBe(
    `https://github.com/fredrikburmester/fdrive/commit/${revision}`,
  );
  expect(screen.getByText("API uptime").nextElementSibling?.textContent).toBe("1m");
  // The page's own sheet: nothing to close it into.
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
});

it("sends an administrator to About in System", async () => {
  mocks.isAdmin = true;

  await expect(AboutPage()).rejects.toThrow("redirect:/system/about");
  // Only the shell's own setup check asked the API: the page stopped before reading the server.
  expect(mocks.about).toHaveBeenCalledTimes(1);
});
