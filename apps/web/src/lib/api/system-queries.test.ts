// @vitest-environment jsdom
import type { AdminConnectionResponse, MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setupStatusMock = vi.fn();
const setupTestMock = vi.fn();
const setupCompleteMock = vi.fn();
const adminConnectionMock = vi.fn();
const adminUpdateConnectionMock = vi.fn();
const adminTestConnectionMock = vi.fn();

vi.mock("./client.js", () => ({
  apiClient: {
    setupStatus: (...args: unknown[]) => setupStatusMock(...args),
    setupTest: (...args: unknown[]) => setupTestMock(...args),
    setupComplete: (...args: unknown[]) => setupCompleteMock(...args),
    adminConnection: (...args: unknown[]) => adminConnectionMock(...args),
    adminUpdateConnection: (...args: unknown[]) => adminUpdateConnectionMock(...args),
    adminTestConnection: (...args: unknown[]) => adminTestConnectionMock(...args),
  },
}));

const ME_RESPONSE: MeResponse = {
  account: { id: "00000000-0000-0000-0000-000000000000", displayName: "Ada" },
  identities: [
    {
      id: "00000000-0000-0000-0000-000000000001",
      username: "ada",
      providerType: "sftpgo",
      providerLabel: "SFTPGo",
    },
  ],
  activeIdentityId: "00000000-0000-0000-0000-000000000001",
  isAdmin: true,
};

const CONNECTION_RESPONSE: AdminConnectionResponse = {
  baseUrl: "http://sftpgo:8080",
  host: "sftpgo:8080",
  homeTemplate: "sftpgo:/{username}",
  source: "env",
  reachable: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
};

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  setupStatusMock.mockReset();
  setupTestMock.mockReset();
  setupCompleteMock.mockReset();
  adminConnectionMock.mockReset();
  adminUpdateConnectionMock.mockReset();
  adminTestConnectionMock.mockReset();
});

describe("useSetupStatus", () => {
  it("fetches the setup status", async () => {
    setupStatusMock.mockResolvedValue({ required: true, hasEnvUrl: false });
    const { useSetupStatus } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSetupStatus(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(result.current.data).toEqual({ required: true, hasEnvUrl: false }));
  });
});

describe("useSetupTest", () => {
  it("probes a candidate connection with the setup token", async () => {
    setupTestMock.mockResolvedValue({ ok: true, detail: "reachable" });
    const { useSetupTest } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSetupTest(), { wrapper: createWrapper(queryClient) });
    result.current.mutate({ token: "tok-1", baseUrl: "http://sftpgo:8080" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setupTestMock).toHaveBeenCalledWith("tok-1", "http://sftpgo:8080");
  });
});

describe("useSetupComplete", () => {
  it("completes setup and seeds the auth.me cache", async () => {
    setupCompleteMock.mockResolvedValue(ME_RESPONSE);
    const { useSetupComplete } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSetupComplete(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({
      token: "tok-1",
      request: {
        baseUrl: "http://sftpgo:8080",
        homeTemplate: "sftpgo:/{username}",
        username: "ada",
        password: "hunter2",
      },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(["auth", "me"])).toEqual(ME_RESPONSE);
  });
});

describe("useAdminConnection", () => {
  it("fetches the active connection", async () => {
    adminConnectionMock.mockResolvedValue(CONNECTION_RESPONSE);
    const { useAdminConnection } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useAdminConnection(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(CONNECTION_RESPONSE));
  });
});

describe("useAdminUpdateConnection", () => {
  it("updates the connection and refreshes the cached summary", async () => {
    const updated = { ...CONNECTION_RESPONSE, homeTemplate: "sftpgo:/new/{username}" };
    adminUpdateConnectionMock.mockResolvedValue(updated);
    const { useAdminUpdateConnection } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useAdminUpdateConnection(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({ homeTemplate: "sftpgo:/new/{username}" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(["admin", "connection"])).toEqual(updated);
  });
});

describe("useAdminTestConnection", () => {
  it("probes the active connection when no baseUrl is given", async () => {
    adminTestConnectionMock.mockResolvedValue({ ok: true, detail: "reachable" });
    const { useAdminTestConnection } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useAdminTestConnection(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate(undefined);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(adminTestConnectionMock).toHaveBeenCalledWith(undefined);
  });

  it("probes a candidate baseUrl when given", async () => {
    adminTestConnectionMock.mockResolvedValue({ ok: false, detail: "unreachable" });
    const { useAdminTestConnection } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useAdminTestConnection(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate("http://other:8080");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(adminTestConnectionMock).toHaveBeenCalledWith("http://other:8080");
  });
});
