// @vitest-environment jsdom
import type { AboutResponse } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const about = vi.fn<() => Promise<AboutResponse>>();
vi.mock("@/lib/api/server", () => ({ serverApiClient: async () => ({ about }) }));

import SystemAboutPage from "./page";

afterEach(cleanup);

it("shows the running server in the About sheet, for the System frame to place", async () => {
  about.mockResolvedValue({
    version: "0.8.0",
    release: "0.8.0",
    uptimeSeconds: 3 * 3600 + 120,
    setupRequired: false,
  });
  const { container } = render(await SystemAboutPage());

  // The sheet alone: the System layout draws the header and the list of areas around it.
  expect(container.firstElementChild?.getAttribute("data-slot")).toBe("detail-sheet");
  expect(screen.getByRole("heading", { level: 1, name: "About fdrive" })).toBeTruthy();
  expect(screen.getByText("Version").nextElementSibling?.textContent).toBe("0.8.0");
  expect(screen.queryByText("Revision")).toBeNull();
  expect(screen.getByText("API uptime").nextElementSibling?.textContent).toBe("3h 2m");
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
});
