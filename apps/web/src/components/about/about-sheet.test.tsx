// @vitest-environment jsdom
import type { AboutResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AboutSheet } from "./about-sheet";

afterEach(cleanup);

const GITHUB = "https://github.com/fredrikburmester/fdrive";
const revision = "0123456789abcdef0123456789abcdef01234567";
const short = revision.slice(0, 12);

function build(overrides: Partial<AboutResponse> = {}): AboutResponse {
  return { version: "development", uptimeSeconds: 90, setupRequired: false, ...overrides };
}

/** A fact's value: the `dd` beside the `dt` with that label. */
function fact(label: string): HTMLElement {
  const value = screen.getByText(label, { selector: "dt" }).nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`${label} has no value`);
  return value;
}

it("shows the release, with its commit linked in the mono face", () => {
  render(<AboutSheet about={build({ version: revision, release: "0.1.0", revision })} />);

  expect(fact("Version").textContent).toBe("0.1.0");
  const commit = within(fact("Revision")).getByRole("link", { name: short });
  expect(commit.getAttribute("href")).toBe(`${GITHUB}/commit/${revision}`);
  expect(commit.getAttribute("title")).toBe(revision);
  expect(commit.querySelector("code")?.className).toContain("font-mono");
});

it("labels a development build without a commit, and shows no revision", () => {
  render(<AboutSheet about={build()} />);

  expect(fact("Version").textContent).toBe("Development (version unavailable)");
  expect(screen.queryByText("Revision")).toBeNull();
});

it("labels a development build with its commit linked", () => {
  render(<AboutSheet about={build({ version: revision, revision })} />);

  expect(fact("Version").textContent).toBe("Development");
  expect(within(fact("Revision")).getByRole("link", { name: short }).getAttribute("href")).toBe(
    `${GITHUB}/commit/${revision}`,
  );
});

it("says how long the API has been up, and when that was read", () => {
  render(<AboutSheet about={build({ uptimeSeconds: 3 * 86400 + 4 * 3600 + 5 * 60 })} />);

  expect(fact("API uptime").textContent).toBe("3d 4h 5m");
  expect(screen.getByText(/resets when the API restarts/)).toBeTruthy();
});

it("is headed by the wordmark, names itself About fdrive and ends in the license", () => {
  const { container } = render(<AboutSheet about={build()} />);

  const heading = screen.getByRole("heading", { level: 1, name: "About fdrive" });
  // The display size, used nowhere else.
  expect(heading.querySelector("span")?.className).toContain("text-[44px]");
  expect(screen.getByRole("region", { name: "About fdrive" })).toBeTruthy();
  expect(
    screen.getByText("Your files, on your server. Browse, preview, search, and share."),
  ).toBeTruthy();
  const footer = container.querySelector('[data-slot="detail-sheet-footer"]');
  expect(footer?.textContent).toBe("fdrive is licensed under the AGPL-3.0 license.");
  // Quiet: named values and rows, no cards and no setting rows.
  expect(container.querySelector('[data-slot="fact-list"]')).not.toBeNull();
  expect(container.querySelector('[data-slot="card"]')).toBeNull();
  expect(container.querySelector('[data-slot="setting-row"]')).toBeNull();
});

it("links to the project and to every feature guide, each in a new tab", () => {
  const { container } = render(<AboutSheet about={build({ revision })} />);

  const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
  expect(href("GitHub")).toBe(GITHUB);
  expect(href("FDrive for macOS")).toBe(`${GITHUB}/blob/main/docs/MACOS.md`);
  expect(href("Buy Me a Coffee")).toBe("https://buymeacoffee.com/fredrikbur3");
  expect(href("Files, previews & sharing")).toBe(`${GITHUB}/blob/main/README.md#highlights`);
  expect(href("Search & AI")).toBe(`${GITHUB}/blob/main/docs/SEARCH-AND-AI.md`);
  expect(href("MCP integration")).toBe(`${GITHUB}/blob/main/docs/MCP.md`);
  expect(screen.getByRole("heading", { name: "Feature documentation" })).toBeTruthy();
  // Three project links and eight guides as rows, plus the commit.
  expect(container.querySelectorAll('a[data-slot="resource-link"]')).toHaveLength(11);
  const links = screen.getAllByRole("link");
  expect(links).toHaveLength(12);
  for (const link of links) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  }
});

it("shows what it is given in place of the server's facts while they are not there", () => {
  const { container } = render(
    <AboutSheet about={undefined} titleAs="h2">
      <p role="status">Loading…</p>
    </AboutSheet>,
  );

  expect(screen.getByRole("status").textContent).toBe("Loading…");
  expect(container.querySelector('[data-slot="fact-list"]')).toBeNull();
  // Everything that does not need the server is already there.
  expect(screen.getByRole("heading", { level: 2, name: "About fdrive" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "GitHub" })).toBeTruthy();
});

it("closes when it is given a way to", () => {
  let closed = 0;
  render(<AboutSheet about={build()} onClose={() => closed++} />);

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(closed).toBe(1);
});
