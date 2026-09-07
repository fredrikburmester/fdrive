// @vitest-environment jsdom
import type { MeResponse, SearchHit } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { SearchPanel } from "./search-panel";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/files" }));

/**
 * `SearchPanel` calls `useIsMobile`, which reads `window.matchMedia` (jsdom
 * does not implement it) and decides mobile from `window.innerWidth`
 * against the same 768px breakpoint, not from the media query's `matches`.
 */
function stubMatchMedia(mobile: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: mobile,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: mobile ? 390 : 1024,
  });
}
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
beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function renderPanel(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <SearchPanel open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

it("defaults to current login, labels account duplicates and partial failures without thumbnails", async () => {
  stubMatchMedia(false);
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
  renderPanel(client);
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
});

it("shows the Enter-opens footer and keyboard hints on desktop", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  expect(screen.getByText("Enter opens:")).toBeDefined();
  expect(screen.getByText("open")).toBeDefined();
});

it("hides the Enter-opens footer and keyboard hints on mobile, keeping the reveal button reachable", async () => {
  stubMatchMedia(true);
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "same",
    sections: { folders: [], files: [hit], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.change(screen.getByPlaceholderText("Search files and content..."), {
    target: { value: "same" },
  });
  await waitFor(() => expect(screen.getAllByText("same.txt")).toHaveLength(1));

  expect(screen.queryByText("Enter opens:")).toBeNull();
  expect(screen.queryByText("open")).toBeNull();
  expect(screen.getByRole("button", { name: "Reveal in folder" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
});
