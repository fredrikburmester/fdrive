// @vitest-environment jsdom
import type { ManagedShare } from "@fdrive/contracts";
import { ApiClientError } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharesPage } from "./shares-page";

const mocks = vi.hoisted(() => ({ query: {} as Record<string, unknown> }));
vi.mock("@/lib/shares/management", () => ({
  useShareManagement: () => ({
    query: mocks.query,
    create: vi.fn(),
    update: vi.fn(),
    revoke: vi.fn(),
    entries: vi.fn(),
  }),
}));
vi.mock("@/components/grants/shared-with-people-section", () => ({
  SharedWithPeopleSection: () => <section aria-label="Shared with people" />,
}));
// The shell header needs the sidebar context and search wiring this page test does not exercise.
vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => <header /> }));

const share: ManagedShare = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Quarterly report",
  description: "",
  scope: "read",
  paths: ["/report.pdf"],
  publicPath: "/s/00000000-0000-4000-8000-000000000001",
  hasPassword: false,
  expiresAt: null,
  maxDownloads: 0,
  usedDownloads: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  presentation: "auto",
};

beforeEach(() => {
  mocks.query = { isPending: false, isError: false, error: null, data: { items: [share] } };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("lists the login's links and the folders it shares with people", () => {
  render(<SharesPage />);
  expect(screen.getByText("Quarterly report")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Shared with people" })).toBeTruthy();
});

it("says it is loading until the links arrive", () => {
  mocks.query = { isPending: true, isError: false, error: null, data: undefined };
  render(<SharesPage />);
  expect(screen.getByRole("status").textContent).toBe("Loading links…");
});

it("shows a failed listing as an alert without an empty table beneath it", () => {
  mocks.query = {
    isPending: false,
    isError: true,
    error: new ApiClientError("upstream_unavailable", "Share storage unavailable", 503),
    data: undefined,
  };
  render(<SharesPage />);
  expect(screen.getByText("Could not load share links")).toBeTruthy();
  expect(
    screen.getByText("fdrive can't reach the server. Check your connection and try again."),
  ).toBeTruthy();
  expect(screen.queryByRole("columnheader", { name: "Name" })).toBeNull();
  expect(screen.queryByText("No share links yet")).toBeNull();
});
