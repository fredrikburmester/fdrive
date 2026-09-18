// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountTransition } from "@/lib/account/transition";
import { managedSharesKey, useShareManagement } from "./management";

const mocks = vi.hoisted(() => ({
  identity: "left",
  clients: new Map<
    string,
    {
      listShares: ReturnType<typeof vi.fn>;
      createShare: ReturnType<typeof vi.fn>;
      updateShare: ReturnType<typeof vi.fn>;
      deleteShare: ReturnType<typeof vi.fn>;
      stat: ReturnType<typeof vi.fn>;
    }
  >(),
}));
vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/client")>()),
  getTabIdentity: () => mocks.identity,
  snapshotTabApiClient: () => mocks.clients.get(mocks.identity),
  pinTabIdentity: vi.fn(),
}));
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, ...renderHook(() => useShareManagement(), { wrapper }) };
}
beforeEach(() => {
  accountTransition.finish(false);
  mocks.identity = "left";
  mocks.clients.clear();
  for (const identity of ["left", "right"])
    mocks.clients.set(identity, {
      listShares: vi.fn().mockResolvedValue({ items: [] }),
      createShare: vi.fn().mockResolvedValue({ id: identity }),
      updateShare: vi.fn().mockResolvedValue({ id: identity }),
      deleteShare: vi.fn().mockResolvedValue({ ok: true }),
      stat: vi.fn().mockResolvedValue({ path: "/a.txt" }),
    });
});
afterEach(cleanup);
describe("share management ownership", () => {
  it("captures displayed identity across another tab's active identity switch", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    mocks.identity = "right";
    const input = {
      name: "Link",
      description: "",
      paths: ["/a.txt"],
      scope: "read" as const,
      expiresAt: null,
      maxDownloads: 0,
      presentation: "auto" as const,
      password: "local-input",
    };
    await act(async () => {
      expect(await result.current.create(input)).toEqual({ id: "left" });
      await result.current.update("id", { name: "Renamed" });
      await result.current.revoke("id");
      expect(await result.current.entries(["/a.txt"])).toEqual([{ path: "/a.txt" }]);
    });
    expect(mocks.clients.get("left")?.createShare).toHaveBeenCalledWith(input);
    expect(mocks.clients.get("right")?.createShare).not.toHaveBeenCalled();
    expect(managedSharesKey("left")).toEqual(["shares", "managed", "left"]);
  });
  it("rejects stale/paused actions and drops responses after an identity transition", async () => {
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    let finish: (value: unknown) => void = () => {
      throw new Error("not ready");
    };
    mocks.clients.get("left")?.updateShare.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.update("id", { name: "x" });
      accountTransition.begin();
    });
    await expect(result.current.revoke("id")).rejects.toThrow("active login changed");
    act(() => {
      accountTransition.finish(true);
      finish({ id: "old" });
    });
    await expect(pending).resolves.toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
    await expect(result.current.query.refetch({ throwOnError: true })).rejects.toThrow(
      "active login changed",
    );
  });
  it("cancels an initial empty list request before refreshing after creation", async () => {
    let finish: (value: unknown) => void = () => {};
    const left = mocks.clients.get("left");
    left?.listShares
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ items: [{ id: "new" }] });
    const { result } = setup();
    await waitFor(() => expect(left?.listShares).toHaveBeenCalledOnce());
    await act(async () => {
      await result.current.create({
        name: "New",
        description: "",
        paths: ["/a.txt"],
        scope: "read",
        expiresAt: null,
        maxDownloads: 0,
        presentation: "auto",
      });
    });
    await waitFor(() => expect(result.current.query.data).toEqual({ items: [{ id: "new" }] }));
    await act(async () => finish({ items: [] }));
    expect(result.current.query.data).toEqual({ items: [{ id: "new" }] });
  });
  it("guards a transition while post-write invalidation is pending", async () => {
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    let finish = () => {};
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = result.current.revoke("id");
    await waitFor(() => expect(queryClient.invalidateQueries).toHaveBeenCalled());
    act(() => {
      accountTransition.begin();
      accountTransition.finish(true);
      finish();
    });
    await expect(pending).resolves.toBeNull();
  });
});
describe("share management for a login that cannot share", () => {
  it("never lists, yet still runs writes and refreshes for the displayed login", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useShareManagement({ list: false }), { wrapper });
    await act(async () => {
      expect(await result.current.revoke("id")).toEqual({ ok: true });
    });
    expect(mocks.clients.get("left")?.listShares).not.toHaveBeenCalled();
    expect(result.current.query.fetchStatus).toBe("idle");
    expect(result.current.query.data).toBeUndefined();
  });
});
