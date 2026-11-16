// @vitest-environment jsdom
import type { ReceivedGrant } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";

const TRIP: ReceivedGrant = {
  id: "00000000-0000-4000-8000-0000000000b1",
  owner: "alice",
  name: "Trip",
  path: "/Shared with me/Trip",
  access: "read",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const mocks = vi.hoisted(() => ({
  received: [] as ReceivedGrant[],
  pathname: "/files" as string | null,
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/lib/grants/queries", () => ({ useReceivedGrants: () => mocks.received }));

const { SharedWithMeItem } = await import("./shared-with-me-item");

function renderItem() {
  return render(
    <SidebarProvider>
      <SharedWithMeItem />
    </SidebarProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.received = [];
  mocks.pathname = "/files";
});

it("links to Shared with me while something is shared with the login", () => {
  mocks.received = [TRIP];
  renderItem();

  const link = screen.getByRole("link", { name: "Shared with me" });
  expect(link.getAttribute("href")).toBe("/files/Shared%20with%20me");
  expect(link.hasAttribute("data-active")).toBe(false);
});

it("is marked active inside Shared with me", () => {
  mocks.received = [TRIP];
  mocks.pathname = "/files/Shared%20with%20me/Trip";
  renderItem();

  expect(screen.getByRole("link", { name: "Shared with me" }).hasAttribute("data-active")).toBe(
    true,
  );
});

it("stays hidden with nothing shared", () => {
  renderItem();

  expect(screen.queryByRole("link", { name: "Shared with me" })).toBeNull();
});
