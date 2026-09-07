// @vitest-environment jsdom
import type { MeResponse, SearchHit } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { SearchPanel } from "./search-panel";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/files" }));
const me: MeResponse = {
  account: { id: "a", displayName: "Ada" },
  identities: [
    { id: "one", username: "ada", providerType: "sftpgo", providerLabel: "Main" },
    { id: "two", username: "bob", providerType: "sftpgo", providerLabel: "Other" },
  ],
  activeIdentityId: "one",
  isAdmin: false,
};
const hit: SearchHit = {
  name: "same.txt",
  path: "/same.txt",
  kind: "file",
  ext: ".txt",
  mime: "text/plain",
  size: 1,
  modifiedAt: "2026-01-01T00:00:00Z",
  score: 1,
  snippets: [],
  hasThumbnail: true,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("defaults to current login, labels account duplicates and partial failures without thumbnails", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "same",
    sections: { folders: [], files: [hit], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  const all = vi.spyOn(apiClient, "accountSearch").mockResolvedValue({
    query: "same",
    sections: {
      folders: [],
      files: [
        { ...hit, identityId: "one" },
        { ...hit, identityId: "two" },
      ],
      content: [],
    },
    degraded: false,
    unavailable: false,
    tookMs: 1,
    unavailableIdentityIds: ["two"],
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  render(
    <QueryClientProvider client={client}>
      <SearchPanel open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByPlaceholderText("Search files and content..."), {
    target: { value: "same" },
  });
  await waitFor(() => expect(screen.getAllByText("same.txt")).toHaveLength(1));
  expect(all).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "All linked logins" }));
  await waitFor(() => expect(screen.getAllByText("same.txt")).toHaveLength(2));
  expect(screen.getByText("ada · Main")).toBeDefined();
  expect(screen.getByText("bob · Other")).toBeDefined();
  expect(screen.getByRole("status").textContent).toContain("Search unavailable for bob · Other");
  expect(document.querySelector("img")).toBeNull();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});
