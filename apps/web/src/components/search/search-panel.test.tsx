// @vitest-environment jsdom
import type {
  ImageSearchHit,
  ImageSearchResponse,
  MeResponse,
  SearchHit,
  SearchResponse,
} from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { SearchPanel } from "./search-panel";

const push = vi.fn();
const pathnameMock = vi.fn(() => "/files");
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathnameMock(),
}));

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
  pathnameMock.mockReturnValue("/files");
  push.mockReset();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
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

  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
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

  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
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

  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
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

it("never renders a manual Images mode toggle, keeping filters visible", async () => {
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
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  await waitFor(() => expect(apiClient.searchStatus).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Search images" })).toBeNull();
  expect(screen.getByRole("button", { name: "Any type" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Images" })).toBeDefined();
  expect(screen.getByRole("button", { name: "This folder only" })).toBeDefined();
});

it("runs text and visual search concurrently and displays both sections", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  const searchMock = vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "sunset",
    sections: { folders: [], files: [hit], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  const searchImagesMock = vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "sunset",
    hits: [imageHit],
    unavailable: false,
    tookMs: 1,
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
    target: { value: "sunset" },
  });

  await waitFor(() => expect(searchMock).toHaveBeenCalledWith("sunset", expect.any(Object)));
  await waitFor(() => expect(searchImagesMock).toHaveBeenCalledWith("sunset", { limit: 24 }));

  expect(await screen.findByText("same.txt")).toBeDefined();
  expect(await screen.findByText("sunset.jpg")).toBeDefined();
  expect(screen.getByText("Files")).toBeDefined();
  expect(screen.getByText("Visual matches")).toBeDefined();
});

it("renders text results without waiting for images and leaves text usable on image failure", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "same",
    sections: { folders: [], files: [hit], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  vi.spyOn(apiClient, "searchImages").mockRejectedValue(new Error("Visual sidecar offline"));

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
    target: { value: "same" },
  });

  await waitFor(() => expect(screen.getByText("same.txt")).toBeDefined());
  expect(screen.getByText("Files")).toBeDefined();
  expect(screen.queryByText("Visual matches")).toBeNull();
});

it("deduplicates visual hits matching path and active identity already shown in Files", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  const textImageHit: SearchHit = {
    ...hit,
    name: "sunset.jpg",
    path: "/photos/sunset.jpg",
    ext: ".jpg",
  };
  const otherImageHit: ImageSearchHit = {
    ...imageHit,
    name: "beach.jpg",
    path: "/photos/beach.jpg",
  };
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "sunset",
    sections: { folders: [], files: [textImageHit], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "sunset",
    hits: [imageHit, otherImageHit],
    unavailable: false,
    tookMs: 1,
  });

  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
    target: { value: "sunset" },
  });

  await waitFor(() => expect(screen.getByText("beach.jpg")).toBeDefined());
  expect(screen.getAllByText("sunset.jpg")).toHaveLength(1);
});

it("truthfully labels visual matches scope when all linked logins is selected", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "accountSearch").mockResolvedValue({
    query: "sunset",
    sections: { folders: [], files: [{ ...hit, identityId: "two" }], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
    unavailableIdentityIds: [],
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

  fireEvent.click(screen.getByRole("button", { name: "All linked logins" }));
  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
    target: { value: "sunset" },
  });

  await waitFor(() => expect(screen.getByText("Visual matches (ada · Main only)")).toBeDefined());
});

it("applies boundary-aware folder filtering and acknowledges limited candidates", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  pathnameMock.mockReturnValue("/files/photos");
  const insideHit: ImageSearchHit = {
    ...imageHit,
    name: "inside.jpg",
    path: "/photos/inside.jpg",
  };
  const prefixBoundaryMismatch: ImageSearchHit = {
    ...imageHit,
    name: "mismatch.jpg",
    path: "/photosextra/mismatch.jpg",
  };
  const outsideHit: ImageSearchHit = {
    ...imageHit,
    name: "outside.jpg",
    path: "/other/outside.jpg",
  };
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "pic",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "pic",
    hits: [insideHit, prefixBoundaryMismatch, outsideHit],
    unavailable: false,
    tookMs: 1,
  });

  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.click(screen.getByRole("button", { name: "This folder only" }));
  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
    target: { value: "pic" },
  });

  await waitFor(() => expect(screen.getByText("inside.jpg")).toBeDefined());
  expect(screen.queryByText("mismatch.jpg")).toBeNull();
  expect(screen.queryByText("outside.jpg")).toBeNull();
  expect(
    screen.getByText("Visual search checks top matches; more images may exist in this folder."),
  ).toBeDefined();
});

it("skips visual request for non-image file type filters", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  const searchMock = vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "doc",
    sections: { folders: [], files: [hit], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  const searchImagesMock = vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "doc",
    hits: [imageHit],
    unavailable: false,
    tookMs: 1,
  });

  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.click(screen.getByRole("button", { name: "Documents" }));
  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
    target: { value: "doc" },
  });

  await waitFor(() => expect(searchMock).toHaveBeenCalled());
  expect(searchImagesMock).not.toHaveBeenCalled();
});

it("supports keyboard navigation, Enter open, and reveal actions on visual matches", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "sunset",
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

  const input = screen.getByPlaceholderText("Search files, content, and images...");
  fireEvent.change(input, { target: { value: "sunset" } });

  await screen.findByText("sunset.jpg");

  // Enter to open
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(push).toHaveBeenCalledWith("/view/photos/sunset.jpg"));

  // Reveal button click
  const revealBtn = screen.getByRole("button", { name: "Reveal in folder" });
  fireEvent.click(revealBtn);
  await waitFor(() => expect(push).toHaveBeenCalledWith("/files/photos?select=sunset.jpg"));
});

it("renders visual matches and truthful status notice when text search is unavailable", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "sunset",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: true,
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

  const input = screen.getByPlaceholderText("Search files, content, and images...");
  fireEvent.change(input, { target: { value: "sunset" } });

  await waitFor(() => expect(screen.getByText("sunset.jpg")).toBeDefined());
  await waitFor(() => expect(screen.getByText("Text search is unavailable.")).toBeDefined());
  expect(screen.queryByText("Search is not available.")).toBeNull();
});

it("renders text matches and truthful status notice when visual search is unavailable", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "sunset",
    sections: { folders: [], files: [hit], content: [] },
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

  const input = screen.getByPlaceholderText("Search files, content, and images...");
  fireEvent.change(input, { target: { value: "sunset" } });

  await waitFor(() => expect(screen.getByText("same.txt")).toBeDefined());
  expect(screen.getByText("Visual search is unavailable.")).toBeDefined();
});

it("shows Search is not available when both text and visual search are unavailable", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "sunset",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: true,
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

  const input = screen.getByPlaceholderText("Search files, content, and images...");
  fireEvent.change(input, { target: { value: "sunset" } });

  await waitFor(() => expect(screen.getByText("Search is not available.")).toBeDefined());
});

it("keeps permanent scope failures unavailable without startup wording", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: false,
    semantic: false,
    images: false,
    reason: "no_roots",
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "ready",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: true,
    tookMs: 1,
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
    target: { value: "ready" },
  });

  await waitFor(() => expect(screen.getByText("Search is not available.")).toBeDefined());
  expect(screen.queryByText("Search is starting… Retrying automatically.")).toBeNull();
});

it("starts visual search when transient status recovery enables images", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: false,
    semantic: false,
    images: false,
    reason: "indexer_unreachable",
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "sunset",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: true,
    tookMs: 1,
  });
  const searchImages = vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "sunset",
    hits: [],
    unavailable: false,
    tookMs: 1,
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  client.setQueryData(["search", "status"], {
    available: false,
    semantic: false,
    images: false,
    reason: "indexer_unreachable",
  });
  renderPanel(client);

  fireEvent.change(screen.getByPlaceholderText("Search files, content, and images..."), {
    target: { value: "sunset" },
  });
  await waitFor(() => expect(apiClient.search).toHaveBeenCalled());
  expect(searchImages).not.toHaveBeenCalled();

  await act(async () => {
    client.setQueryData(["search", "status"], { available: true, semantic: true, images: true });
  });
  await waitFor(() => expect(searchImages).toHaveBeenCalledWith("sunset", { limit: 24 }));
});

it("renders partial results notice even when visual hits count is zero", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "sunset",
    sections: { folders: [], files: [hit], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "sunset",
    hits: [],
    partial: true,
    unavailable: false,
    tookMs: 1,
  });

  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  const input = screen.getByPlaceholderText("Search files, content, and images...");
  fireEvent.change(input, { target: { value: "sunset" } });

  await waitFor(() => expect(screen.getByText("Some results omitted.")).toBeDefined());
  expect(screen.getByText("same.txt")).toBeDefined();
});

it("renders generic folder notice and never claims outside when all in-folder visual hits are deduplicated", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  pathnameMock.mockReturnValue("/files/photos");
  const inFolderHit: ImageSearchHit = {
    ...imageHit,
    name: "sunset.jpg",
    path: "/photos/sunset.jpg",
  };
  const textHit: SearchHit = {
    ...hit,
    name: "sunset.jpg",
    path: "/photos/sunset.jpg",
    ext: ".jpg",
  };
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "sunset",
    sections: { folders: [], files: [textHit], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "sunset",
    hits: [inFolderHit],
    unavailable: false,
    tookMs: 1,
  });

  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  fireEvent.click(screen.getByRole("button", { name: "This folder only" }));
  const input = screen.getByPlaceholderText("Search files, content, and images...");
  fireEvent.change(input, { target: { value: "sunset" } });

  await waitFor(() =>
    expect(
      screen.getByText("Visual search checks top matches; more images may exist in this folder."),
    ).toBeDefined(),
  );
  expect(screen.queryByText(/outside this folder/i)).toBeNull();
  expect(screen.getAllByText("sunset.jpg")).toHaveLength(1);
});

it("renders restrained independent loading status while searches are in flight", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  let resolveSearch!: (value: SearchResponse) => void;
  let resolveImages!: (value: ImageSearchResponse) => void;
  vi.spyOn(apiClient, "search").mockImplementation(
    () =>
      new Promise<SearchResponse>((resolve) => {
        resolveSearch = resolve;
      }),
  );
  vi.spyOn(apiClient, "searchImages").mockImplementation(
    () =>
      new Promise<ImageSearchResponse>((resolve) => {
        resolveImages = resolve;
      }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  const input = screen.getByPlaceholderText("Search files, content, and images...");
  fireEvent.change(input, { target: { value: "sunset" } });

  // While both are in flight and 0 results so far: Searching... in list
  await waitFor(() => expect(screen.getByText("Searching...")).toBeDefined());
  expect(screen.queryByText(/no results/i)).toBeNull();

  // Resolve text search with results while images still in flight
  resolveSearch({
    query: "sunset",
    sections: { folders: [], files: [hit], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  await waitFor(() => expect(screen.getByText("same.txt")).toBeDefined());
  expect(screen.getByText("Searching visual matches...")).toBeDefined();

  // Resolve images
  resolveImages({
    query: "sunset",
    hits: [imageHit],
    unavailable: false,
    tookMs: 1,
  });
  await waitFor(() => expect(screen.getByText("sunset.jpg")).toBeDefined());
  expect(screen.queryByText("Searching visual matches...")).toBeNull();
});

it("uses qualified no-results wording when visual search is unavailable", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "nomatch",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "nomatch",
    hits: [],
    unavailable: true,
    tookMs: 1,
  });

  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  const input = screen.getByPlaceholderText("Search files, content, and images...");
  fireEvent.change(input, { target: { value: "nomatch" } });

  await waitFor(() => expect(screen.getByText('No text results for "nomatch".')).toBeDefined());
  expect(screen.getByText("Visual search is unavailable.")).toBeDefined();
});

it("uses qualified no-results wording when visual results are partial", async () => {
  stubMatchMedia(false);
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: true,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "nomatch",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 1,
  });
  vi.spyOn(apiClient, "searchImages").mockResolvedValue({
    query: "nomatch",
    hits: [],
    partial: true,
    unavailable: false,
    tookMs: 1,
  });

  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  const input = screen.getByPlaceholderText("Search files, content, and images...");
  fireEvent.change(input, { target: { value: "nomatch" } });

  await waitFor(() =>
    expect(screen.getByText('No results found in checked candidates for "nomatch".')).toBeDefined(),
  );
  expect(screen.getByText("Some results omitted.")).toBeDefined();
});

it("renders visible File type label in the filter bar", async () => {
  stubMatchMedia(false);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  renderPanel(client);

  expect(screen.getByText("File type:")).toBeDefined();
});
