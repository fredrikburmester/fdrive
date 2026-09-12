// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeIdentity, makeMe } from "@/test-fixtures/identity";

const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

const meMock = vi.fn();
const loginMock = vi.fn();
const logoutMock = vi.fn();

vi.mock("./client.js", () => ({
  pinTabIdentity: vi.fn(),
  apiClient: {
    me: (...args: unknown[]) => meMock(...args),
    login: (...args: unknown[]) => loginMock(...args),
    logout: (...args: unknown[]) => logoutMock(...args),
  },
}));

const ME_RESPONSE = makeMe({
  account: { id: "00000000-0000-0000-0000-000000000000", displayName: "Ada" },
  identities: [
    makeIdentity({ id: "00000000-0000-0000-0000-000000000001", providerLabel: "SFTPGo" }),
  ],
  activeIdentityId: "00000000-0000-0000-0000-000000000001",
});

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  routerPush.mockReset();
  meMock.mockReset();
  loginMock.mockReset();
  logoutMock.mockReset();
});

describe("handleLoginSuccess and handleLogoutSuccess", () => {
  it("seeds the auth.me cache and pushes /files on login success", async () => {
    const { handleLoginSuccess } = await import("./auth-queries.js");
    const queryClient = new QueryClient();

    handleLoginSuccess(queryClient, { push: routerPush }, ME_RESPONSE);

    expect(queryClient.getQueryData(["auth", "me"])).toEqual(ME_RESPONSE);
    expect(routerPush).toHaveBeenCalledWith("/files");
  });

  it("lets an administrator resume setup before entering the shell", async () => {
    const { handleLoginSuccess } = await import("./auth-queries.js");
    handleLoginSuccess(new QueryClient(), { push: routerPush }, { ...ME_RESPONSE, isAdmin: true });
    expect(routerPush).toHaveBeenCalledWith("/setup");
  });

  it("clears the cache and pushes /login on logout success", async () => {
    const { handleLogoutSuccess } = await import("./auth-queries.js");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["auth", "me"], ME_RESPONSE);

    handleLogoutSuccess(queryClient, { push: routerPush });

    expect(queryClient.getQueryData(["auth", "me"])).toBeUndefined();
    expect(routerPush).toHaveBeenCalledWith("/login");
  });
});

describe("useMe", () => {
  it("fetches the signed-in account", async () => {
    meMock.mockResolvedValue(ME_RESPONSE);
    const { useMe } = await import("./auth-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useMe(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(result.current.data).toEqual(ME_RESPONSE));
    expect(meMock).toHaveBeenCalledTimes(1);
  });
});

describe("useLogin", () => {
  it("seeds the cache and navigates to /files on success", async () => {
    loginMock.mockResolvedValue(ME_RESPONSE);
    const { useLogin } = await import("./auth-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useLogin(), { wrapper: createWrapper(queryClient) });
    result.current.mutate({ credential: { username: "ada", password: "secret" } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(["auth", "me"])).toEqual(ME_RESPONSE);
    expect(routerPush).toHaveBeenCalledWith("/files");
  });
});

describe("useLogout", () => {
  it("clears the cache and navigates to /login on success", async () => {
    logoutMock.mockResolvedValue({ ok: true });
    const { useLogout } = await import("./auth-queries.js");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["auth", "me"], ME_RESPONSE);

    const { result } = renderHook(() => useLogout(), { wrapper: createWrapper(queryClient) });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(["auth", "me"])).toBeUndefined();
    expect(routerPush).toHaveBeenCalledWith("/login");
  });
});
