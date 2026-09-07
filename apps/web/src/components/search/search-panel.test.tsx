// @vitest-environment jsdom
import type { ImageSearchHit, MeResponse, SearchHit } from "@fdrive/contracts";
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
  // Every test gets a resolved, images-disabled status by default so the
  // panel's own `useSearchStatus` call never hits the real network; tests
  // that exercise image search override this with their own mock.
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: false,
  });
  window.sessionStorage.clear();
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

const longPath =
  "/Documents/University/Books/Course Books/(TNG032)Fourier and Laplace Transforms. Best of luck to future students who read this file";
const longSnippet =
  "A very long highlighted snippet of matched content that should wrap onto at most two lines and never spill past the dialog edge, no matter how long the underlying text actually is.";

it("truncates a hit row's name and path to one line each, clamps a long snippet to two lines, and keeps the reveal button from shrinking", async () => {
  stubMatchMedia(false);
  const longHit: SearchHit = {
    name: "very-long-file-name-that-would-otherwise-overflow-the-search-row.pdf",
    path: longPath,
    kind: "file",
    ext: ".pdf",
    mime: "application/pdf",
    size: 1,
    modifiedAt: "2026-01-01T00:00:00Z",
    score: 1,
    snippets: [{ text: longSnippet, ranges: [] }],
    hasThumbnail: false,
  };
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "fourier",
    sections: { folders: [], files: [longHit], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.change(screen.getByPlaceholderText("Search files and content..."), {
    target: { value: "fourier" },
  });
  await waitFor(() => expect(screen.getByText(longHit.name)).toBeDefined());

  expect(screen.getByText(longHit.name).className).toContain("truncate");
  expect(screen.getByText(longPath).className).toContain("truncate");
  expect(screen.getByText(longSnippet).closest("p")?.className).toContain("line-clamp-2");
  expect(screen.getByRole("button", { name: "Reveal in folder" }).className).toContain("shrink-0");
});

it("never renders the Folders heading when the response's folders section is empty", async () => {
  stubMatchMedia(false);
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
  await waitFor(() => expect(screen.getByText("same.txt")).toBeDefined());

  expect(screen.queryByText("Folders")).toBeNull();
});

const imageHit: ImageSearchHit = {
  name: "sunset.jpg",
  path: "/photos/sunset.jpg",
  ext: ".jpg",
  mime: "image/jpeg",
  size: 1024,
  modifiedAt: "2026-01-01T00:00:00Z",
  score: 0.9,
};

it("hides the Images toggle when image search is not configured", async () => {
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

  await waitFor(() => expect(apiClient.searchStatus).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Search images" })).toBeNull();
});

it("shows the Images toggle and switches to a thumbnail grid when configured", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  const searchImages = vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "sunset",
    hits: [imageHit],
    unavailable: false,
    tookMs: 1,
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  const toggle = await screen.findByRole("button", { name: "Search images" });
  fireEvent.click(toggle);
  fireEvent.change(screen.getByPlaceholderText("Search files and content..."), {
    target: { value: "sunset" },
  });

  await waitFor(() => expect(searchImages).toHaveBeenCalledWith("sunset", { limit: 24 }));
  expect(await screen.findByText("sunset.jpg")).toBeDefined();
  expect(screen.queryByText("Any type")).toBeNull();
  expect(screen.queryByText("This folder only")).toBeNull();
});

it("opens the selected image hit on Enter", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "sunset",
    hits: [imageHit],
    unavailable: false,
    tookMs: 1,
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.click(await screen.findByRole("button", { name: "Search images" }));
  const input = screen.getByPlaceholderText("Search files and content...");
  fireEvent.change(input, { target: { value: "sunset" } });
  await screen.findByText("sunset.jpg");
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => expect(push).toHaveBeenCalled());
});

it("shows the unavailable and partial states for image search", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "sunset",
    hits: [],
    unavailable: true,
    tookMs: 1,
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.click(await screen.findByRole("button", { name: "Search images" }));
  fireEvent.change(screen.getByPlaceholderText("Search files and content..."), {
    target: { value: "sunset" },
  });

  expect(await screen.findByText("Image search is not available.")).toBeDefined();
});

it("shows an empty state and a partial hint for image search", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  const searchImages = vi
    .spyOn(apiClient, "searchImages")
    .mockResolvedValueOnce({ query: "nothing", hits: [], unavailable: false, tookMs: 1 })
    .mockResolvedValueOnce({
      query: "partial",
      hits: [imageHit],
      unavailable: false,
      partial: true,
      tookMs: 1,
    });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.click(await screen.findByRole("button", { name: "Search images" }));
  fireEvent.change(screen.getByPlaceholderText("Search files and content..."), {
    target: { value: "nothing" },
  });
  expect(await screen.findByText("No matching images")).toBeDefined();

  fireEvent.change(screen.getByPlaceholderText("Search files and content..."), {
    target: { value: "partial" },
  });
  await waitFor(() => expect(searchImages).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("Some results omitted.")).toBeDefined();
});

it("remembers the Images mode for the session via sessionStorage", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "",
    hits: [],
    unavailable: false,
    tookMs: 1,
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  const { unmount } = renderPanel(client);

  fireEvent.click(await screen.findByRole("button", { name: "Search images" }));
  await waitFor(() =>
    expect(window.sessionStorage.getItem("fdrive.search.imageMode")).toBe("true"),
  );
  unmount();

  renderPanel(client);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Search images" }).getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
});
