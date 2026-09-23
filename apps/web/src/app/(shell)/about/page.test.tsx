// @vitest-environment jsdom
import type { AboutResponse } from "@fdrive/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const about = vi.fn<() => Promise<AboutResponse>>();
vi.mock("@/lib/api/server", () => ({ serverApiClient: async () => ({ about }) }));
// The header needs the shell's sidebar and query providers; its own tests cover it.
vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => null }));

import AboutPage from "./page";

afterEach(cleanup);

const revision = "0123456789abcdef0123456789abcdef01234567";
const short = revision.slice(0, 12);

/** Renders the page for this build and returns its Server version value. */
async function serverVersion(build: Pick<AboutResponse, "version" | "release" | "revision">) {
  about.mockResolvedValue({ ...build, uptimeSeconds: 90, providers: [], setupRequired: false });
  render(await AboutPage());
  const value = screen.getByText("Server version").nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error("Server version has no value");
  return value;
}

it("shows the release with its commit linked beside it", async () => {
  const value = await serverVersion({ version: revision, release: "0.1.0", revision });

  expect(value.textContent).toBe(`0.1.0${short}`);
  const commit = within(value).getByRole("link", { name: short });
  expect(commit.getAttribute("href")).toBe(
    `https://github.com/fredrikburmester/fdrive/commit/${revision}`,
  );
  expect(commit.getAttribute("title")).toBe(revision);
  expect(commit.className).toContain("text-muted-foreground");
});

it("labels a development build without a commit", async () => {
  const value = await serverVersion({ version: "development" });

  expect(value.textContent).toBe("Development (version unavailable)");
  expect(within(value).queryByRole("link")).toBeNull();
});

it("shows an older server's commit alone, as it did before releases", async () => {
  const value = await serverVersion({ version: revision });

  expect(value.textContent).toBe(short);
  const commit = within(value).getByRole("link", { name: short });
  expect(commit.getAttribute("href")).toBe(
    `https://github.com/fredrikburmester/fdrive/commit/${revision}`,
  );
  expect(commit.className).not.toContain("text-muted-foreground");
});
