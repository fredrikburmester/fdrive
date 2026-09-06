// @vitest-environment jsdom
import type { ApiTokensResponse, CreateApiTokenResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listApiTokensMock = vi.fn();
const createApiTokenMock = vi.fn();
const revokeApiTokenMock = vi.fn();

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    listApiTokens: (...args: unknown[]) => listApiTokensMock(...args),
    createApiToken: (...args: unknown[]) => createApiTokenMock(...args),
    revokeApiToken: (...args: unknown[]) => revokeApiTokenMock(...args),
  },
}));

const TOKENS_RESPONSE: ApiTokensResponse = {
  items: [
    {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "Claude",
      identityId: "123e4567-e89b-12d3-a456-426614174001",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
    },
  ],
};

const CREATE_RESPONSE: CreateApiTokenResponse = {
  token: "fdr_abc123",
  item: TOKENS_RESPONSE.items[0] as ApiTokensResponse["items"][number],
};

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  listApiTokensMock.mockReset();
  createApiTokenMock.mockReset();
  revokeApiTokenMock.mockReset();
});

describe("useApiTokens", () => {
  it("fetches the account's tokens", async () => {
    listApiTokensMock.mockResolvedValue(TOKENS_RESPONSE);
    const { useApiTokens } = await import("./queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useApiTokens(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(result.current.data).toEqual(TOKENS_RESPONSE));
  });
});

describe("useCreateApiToken", () => {
  it("creates a token and invalidates the tokens list", async () => {
    createApiTokenMock.mockResolvedValue(CREATE_RESPONSE);
    listApiTokensMock.mockResolvedValue(TOKENS_RESPONSE);
    const { useCreateApiToken } = await import("./queries.js");
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateApiToken(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({ name: "Claude" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(createApiTokenMock).toHaveBeenCalledWith({ name: "Claude" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["account", "tokens"] });
  });
});

describe("useRevokeApiToken", () => {
  it("revokes a token and invalidates the tokens list", async () => {
    revokeApiTokenMock.mockResolvedValue({ ok: true });
    const { useRevokeApiToken } = await import("./queries.js");
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRevokeApiToken(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate("token-1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(revokeApiTokenMock).toHaveBeenCalledWith("token-1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["account", "tokens"] });
  });
});
