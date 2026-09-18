// @vitest-environment jsdom
import type { ManagedShare, MeResponse } from "@fdrive/contracts";
import { ApiClientError } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeIdentity, makeMe } from "@/test-fixtures/identity";
import { SharesPage, unavailableNote } from "./shares-page";

const mocks = vi.hoisted(() => ({
  me: undefined as MeResponse | undefined,
  management: vi.fn(),
  query: {} as Record<string, unknown>,
}));
vi.mock("@/lib/api/auth-queries", () => ({ useMe: () => ({ data: mocks.me }) }));
vi.mock("@/lib/shares/management", () => ({
  useShareManagement: (options: unknown) => {
    mocks.management(options);
    return {
      query: mocks.query,
      create: vi.fn(),
      update: vi.fn(),
      revoke: vi.fn(),
      entries: vi.fn(),
    };
  },
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
const sftpgo = makeIdentity({ id: "sftpgo", username: "ada", providerLabel: "Main" });
const s3 = makeIdentity({
  id: "s3",
  username: "0047483a71e6fd50000000001",
  providerType: "s3",
  providerLabel: "B2",
  capabilities: { shares: false, office: false, index: false, scopeMapping: false },
});

beforeEach(() => {
  mocks.query = { isPending: false, isError: false, error: null, data: { items: [share] } };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("lists the active login's links when its storage can share", () => {
  mocks.me = makeMe({ identities: [sftpgo, s3], activeIdentityId: "sftpgo" });
  render(<SharesPage />);
  expect(mocks.management).toHaveBeenCalledWith({ list: true });
  expect(screen.getByText("Quarterly report")).toBeTruthy();
  expect(screen.queryByText(/isn't|aren't/)).toBeNull();
});

it("states the limit for a files-only login instead of asking for a refusal", () => {
  mocks.me = makeMe({ identities: [sftpgo, s3], activeIdentityId: "s3" });
  mocks.query = { isPending: true, isError: false, error: null, data: undefined };
  render(<SharesPage />);
  expect(mocks.management).toHaveBeenCalledWith({ list: false });
  expect(screen.getByText("Shares aren't available for this login")).toBeTruthy();
  // A key login leads with its storage name, never the opaque access key.
  expect(screen.getByText(unavailableNote("B2"))).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("columnheader", { name: "Name" })).toBeNull();
  expect(screen.queryByText("Could not load share links")).toBeNull();
});

it("assumes a sharing login until the account has loaded", () => {
  mocks.me = undefined;
  mocks.query = { isPending: true, isError: false, error: null, data: undefined };
  render(<SharesPage />);
  expect(mocks.management).toHaveBeenCalledWith({ list: true });
  expect(screen.getByRole("status").textContent).toBe("Loading links…");
});

it("shows a failed listing as an alert without an empty table beneath it", () => {
  mocks.me = makeMe({ identities: [sftpgo], activeIdentityId: "sftpgo" });
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
