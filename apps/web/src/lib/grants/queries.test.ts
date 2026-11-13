// @vitest-environment jsdom
import type { GrantsResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  grants: vi.fn(),
  grantPeople: vi.fn(),
  createGrant: vi.fn(),
  updateGrant: vi.fn(),
  deleteGrant: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

const {
  useCreateGrant,
  useDeleteGrant,
  useGrantPeople,
  useGrants,
  useLeaveGrant,
  useReceivedGrants,
  useUpdateGrant,
} = await import("./queries");

const GRANTS: GrantsResponse = {
  available: true,
  owned: [
    {
      id: "00000000-0000-4000-8000-0000000000a1",
      path: "/Photos",
      username: "grace",
      access: "read",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  received: [
    {
      id: "00000000-0000-4000-8000-0000000000b1",
      owner: "alice",
      name: "Trip",
      path: "/Shared with me/Trip",
      access: "write",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

describe("reading grants", () => {
  it("fetches the login's grants and hands out what is shared with it", async () => {
    api.grants.mockResolvedValue(GRANTS);
    const { wrapper } = setup();

    const grants = renderHook(() => useGrants(), { wrapper });
    await waitFor(() => expect(grants.result.current.data).toEqual(GRANTS));
    const received = renderHook(() => useReceivedGrants(), { wrapper });
    await waitFor(() => expect(received.result.current).toEqual(GRANTS.received));
  });

  it("asks nothing for a login whose storage cannot share, and reports none received", () => {
    const { wrapper } = setup();

    const received = renderHook(() => useReceivedGrants(false), { wrapper });
    const people = renderHook(() => useGrantPeople(false), { wrapper });

    expect(received.result.current).toEqual([]);
    expect(people.result.current.fetchStatus).toBe("idle");
    expect(api.grants).not.toHaveBeenCalled();
    expect(api.grantPeople).not.toHaveBeenCalled();
  });

  it("fetches the people a folder can be shared with", async () => {
    api.grantPeople.mockResolvedValue({ usernames: ["grace"] });
    const { wrapper } = setup();

    const people = renderHook(() => useGrantPeople(), { wrapper });

    await waitFor(() => expect(people.result.current.data).toEqual({ usernames: ["grace"] }));
  });
});

describe("changing grants", () => {
  it("shares, changes and stops sharing, refreshing the grants each time", async () => {
    api.createGrant.mockResolvedValue(GRANTS.owned[0]);
    api.updateGrant.mockResolvedValue(GRANTS.owned[0]);
    api.deleteGrant.mockResolvedValue({ ok: true });
    const { client, wrapper } = setup();
    const create = renderHook(() => useCreateGrant(), { wrapper });
    const update = renderHook(() => useUpdateGrant(), { wrapper });
    const remove = renderHook(() => useDeleteGrant(), { wrapper });

    client.setQueryData(["grants", "list"], GRANTS);
    await create.result.current.mutateAsync({
      path: "/Photos",
      username: "grace",
      access: "read",
    });
    expect(api.createGrant).toHaveBeenCalledWith({
      path: "/Photos",
      username: "grace",
      access: "read",
    });
    expect(client.getQueryState(["grants", "list"])?.isInvalidated).toBe(true);

    client.setQueryData(["grants", "list"], GRANTS);
    await update.result.current.mutateAsync({ id: "g1", access: "write" });
    expect(api.updateGrant).toHaveBeenCalledWith("g1", { access: "write" });
    expect(client.getQueryState(["grants", "list"])?.isInvalidated).toBe(true);

    client.setQueryData(["grants", "list"], GRANTS);
    await remove.result.current.mutateAsync("g1");
    expect(api.deleteGrant).toHaveBeenCalledWith("g1");
    expect(client.getQueryState(["grants", "list"])?.isInvalidated).toBe(true);
  });

  it("leaves a shared folder and refreshes Shared with me and the root listing", async () => {
    api.deleteGrant.mockResolvedValue({ ok: true });
    const { client, wrapper } = setup();
    client.setQueryData(["grants", "list"], GRANTS);
    client.setQueryData(["fs", "list", "/Shared with me"], {
      path: "/Shared with me",
      entries: [],
    });
    client.setQueryData(["fs", "list", "/"], { path: "/", entries: [] });
    client.setQueryData(["fs", "list", "/Photos"], { path: "/Photos", entries: [] });
    const leave = renderHook(() => useLeaveGrant(), { wrapper });

    await leave.result.current.mutateAsync("b1");

    expect(api.deleteGrant).toHaveBeenCalledWith("b1");
    expect(client.getQueryState(["grants", "list"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["fs", "list", "/Shared with me"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["fs", "list", "/"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["fs", "list", "/Photos"])?.isInvalidated).toBe(false);
  });
});
