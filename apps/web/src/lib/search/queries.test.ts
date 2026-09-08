// @vitest-environment jsdom
import type { SearchResponse, SearchStatusResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SEARCH_CHIPS } from "./filters";

const accountSearchMock = vi.fn();
const searchMock = vi.fn();
const searchStatusMock = vi.fn();
const searchImagesMock = vi.fn();

vi.mock("./deps.js", () => ({
  apiClient: {
    accountSearch: (...args: unknown[]) => accountSearchMock(...args),
    search: (...args: unknown[]) => searchMock(...args),
    searchStatus: (...args: unknown[]) => searchStatusMock(...args),
    searchImages: (...args: unknown[]) => searchImagesMock(...args),
  },
}));

const EMPTY_RESPONSE: SearchResponse = {
  query: "readme",
  sections: { folders: [], files: [], content: [] },
  degraded: false,
  unavailable: false,
  tookMs: 1,
};

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  searchMock.mockReset();
  searchStatusMock.mockReset();
  searchImagesMock.mockReset();
});

describe("imageSearchQueryKey", () => {
  it("varies with query text", async () => {
    const { imageSearchQueryKey } = await import("./queries.js");
    const a = imageSearchQueryKey("dog", "id-1");
    const b = imageSearchQueryKey("cat", "id-1");
    expect(a).not.toEqual(b);
  });

  it("varies with identity id", async () => {
    const { imageSearchQueryKey } = await import("./queries.js");
    const a = imageSearchQueryKey("sunset", "id-1");
    const b = imageSearchQueryKey("sunset", "id-2");
    const c = imageSearchQueryKey("sunset");
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("is stable for same inputs", async () => {
    const { imageSearchQueryKey } = await import("./queries.js");
    expect(imageSearchQueryKey("sunset", "id-1")).toEqual(imageSearchQueryKey("sunset", "id-1"));
  });
});

describe("searchQueryKey", () => {
  it("varies with the query text", async () => {
    const { searchQueryKey } = await import("./queries.js");
    const a = searchQueryKey("alpha", DEFAULT_SEARCH_CHIPS, "/");
    const b = searchQueryKey("beta", DEFAULT_SEARCH_CHIPS, "/");
    expect(a).not.toEqual(b);
  });

  it("varies with the type chip", async () => {
    const { searchQueryKey } = await import("./queries.js");
    const any = searchQueryKey("q", DEFAULT_SEARCH_CHIPS, "/");
    const images = searchQueryKey("q", { type: "images", folderOnly: false }, "/");
    expect(any).not.toEqual(images);
  });

  it("varies with folderOnly and the current folder", async () => {
    const { searchQueryKey } = await import("./queries.js");
    const off = searchQueryKey("q", { type: "any", folderOnly: false }, "/docs");
    const on = searchQueryKey("q", { type: "any", folderOnly: true }, "/docs");
    expect(off).not.toEqual(on);
  });

  it("is stable for the same inputs", async () => {
    const { searchQueryKey } = await import("./queries.js");
    expect(searchQueryKey("q", DEFAULT_SEARCH_CHIPS, "/")).toEqual(
      searchQueryKey("q", DEFAULT_SEARCH_CHIPS, "/"),
    );
  });
});

describe("useSearchResults", () => {
  it("fetches results for a non-empty query", async () => {
    searchMock.mockResolvedValue(EMPTY_RESPONSE);
    const { useSearchResults } = await import("./queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSearchResults("readme", DEFAULT_SEARCH_CHIPS, "/"), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(EMPTY_RESPONSE));
    expect(searchMock).toHaveBeenCalledWith("readme", { limit: 20 });
  });

  it("does not fetch for an empty query", async () => {
    const { useSearchResults } = await import("./queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSearchResults("   ", DEFAULT_SEARCH_CHIPS, "/"), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when explicitly disabled", async () => {
    const { useSearchResults } = await import("./queries.js");
    const queryClient = new QueryClient();

    renderHook(() => useSearchResults("readme", DEFAULT_SEARCH_CHIPS, "/", { enabled: false }), {
      wrapper: createWrapper(queryClient),
    });

    expect(searchMock).not.toHaveBeenCalled();
  });

  it("passes the extension and folder filters through", async () => {
    searchMock.mockResolvedValue(EMPTY_RESPONSE);
    const { useSearchResults } = await import("./queries.js");
    const queryClient = new QueryClient();

    renderHook(() => useSearchResults("readme", { type: "images", folderOnly: true }, "/docs"), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(searchMock).toHaveBeenCalled());
    expect(searchMock).toHaveBeenCalledWith("readme", {
      limit: 20,
      ext: expect.stringContaining(".jpg"),
      folder: "/docs",
    });
  });
});

describe("useSearchStatus", () => {
  it("fetches the search status", async () => {
    const status: SearchStatusResponse = { available: true, semantic: false };
    searchStatusMock.mockResolvedValue(status);
    const { useSearchStatus } = await import("./queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSearchStatus(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(result.current.data).toEqual(status));
  });
});

describe("useImageSearchResults", () => {
  it("fetches image results for non-empty query", async () => {
    const imageResponse = { query: "sunset", hits: [], unavailable: false, tookMs: 1 };
    searchImagesMock.mockResolvedValue(imageResponse);
    const { useImageSearchResults } = await import("./queries.js");
    const client = new QueryClient();

    const { result } = renderHook(() => useImageSearchResults("sunset", { identityId: "id-1" }), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.data).toEqual(imageResponse));
    expect(searchImagesMock).toHaveBeenCalledWith("sunset", { limit: 24 });
  });

  it("does not fetch when query is empty or disabled", async () => {
    const { useImageSearchResults } = await import("./queries.js");
    const client = new QueryClient();

    const { result } = renderHook(() => useImageSearchResults("   ", { identityId: "id-1" }), {
      wrapper: createWrapper(client),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(searchImagesMock).not.toHaveBeenCalled();

    renderHook(() => useImageSearchResults("sunset", { enabled: false, identityId: "id-1" }), {
      wrapper: createWrapper(client),
    });
    expect(searchImagesMock).not.toHaveBeenCalled();
  });
});

it("uses account search only for all-logins scope and isolates its cache", async () => {
  accountSearchMock.mockResolvedValue({ ...EMPTY_RESPONSE, unavailableIdentityIds: ["other"] });
  const { useSearchResults } = await import("./queries");
  const client = new QueryClient();
  const scope = { accountId: "a", identityId: "i", all: true };
  const { result } = renderHook(
    () => useSearchResults("readme", DEFAULT_SEARCH_CHIPS, "/", { scope }),
    { wrapper: createWrapper(client) },
  );
  await waitFor(() =>
    expect(result.current.data).toHaveProperty("unavailableIdentityIds", ["other"]),
  );
  expect(accountSearchMock).toHaveBeenCalledWith("readme", { limit: 20 });
  expect(searchMock).not.toHaveBeenCalled();
  expect(client.getQueryCache().getAll()[0]?.queryKey).toContainEqual(scope);
});
