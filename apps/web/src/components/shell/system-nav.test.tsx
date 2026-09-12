// @vitest-environment jsdom
import type { SystemActivityItem } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { apiClient } from "@/lib/api/client";
import { SystemNav } from "./system-nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/files" }));
const activity: SystemActivityItem = {
  id: "thumbnails",
  state: "working",
  percent: 63,
  detail: "Rebuilding previews: 63 of 100 files processed",
  warning: false,
  operationIds: ["job"],
};
beforeEach(() =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })),
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(items: SystemActivityItem[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["system", "activity"], { observedAt: new Date().toISOString(), items });
  render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <SystemNav />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  return client;
}
it("keeps labels/icons and exposes progress as an accessible description", async () => {
  vi.spyOn(apiClient, "systemActivity").mockResolvedValue({
    observedAt: new Date().toISOString(),
    items: [activity],
  });
  mount([activity]);
  const link = screen.getByRole("link", { name: "Thumbnails" });
  expect(link.textContent).toContain("63%");
  expect(
    link.querySelector(".animate-spin")?.classList.contains("motion-reduce:animate-none"),
  ).toBe(true);
  expect(
    document.getElementById(link.getAttribute("aria-describedby") ?? "")?.textContent,
  ).toContain("63 of 100");
  expect(link.querySelectorAll("svg")).toHaveLength(2);
  expect(
    screen.getByRole("link", { name: "Full-text search" }).querySelector("[data-system-activity]"),
  ).toBeNull();
});
it("clears stale percentages and stops animating after a failed poll", async () => {
  vi.spyOn(apiClient, "systemActivity").mockRejectedValue(new Error("offline"));
  mount([activity]);
  const link = screen.getByRole("link", { name: "Thumbnails" });
  await waitFor(() =>
    expect(link.querySelector('[data-system-activity="warning"]')).not.toBeNull(),
  );
  expect(link.textContent).not.toContain("63%");
  expect(link.querySelector(".animate-spin")).toBeNull();
});
