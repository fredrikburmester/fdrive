// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managedSharesKey, useShareManagement } from "./management";

const mocks = vi.hoisted(() => ({
  listShares: vi.fn(),
  createShare: vi.fn(),
  updateShare: vi.fn(),
  deleteShare: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: mocks }));
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, ...renderHook(() => useShareManagement(), { wrapper }) };
}
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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listShares.mockResolvedValue({ items: [] });
  mocks.createShare.mockResolvedValue({ id: "new" });
  mocks.updateShare.mockResolvedValue({ id: "updated" });
  mocks.deleteShare.mockResolvedValue({ ok: true });
  mocks.stat.mockResolvedValue({ path: "/a.txt" });
});
afterEach(cleanup);
describe("share management", () => {
  it("creates, updates and revokes links and refreshes the list after each change", async () => {
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await act(async () => {
      expect(await result.current.create(input)).toEqual({ id: "new" });
      expect(await result.current.update("id", { name: "Renamed" })).toEqual({ id: "updated" });
      expect(await result.current.revoke("id")).toEqual({ ok: true });
      expect(await result.current.entries(["/a.txt"])).toEqual([{ path: "/a.txt" }]);
    });
    expect(mocks.createShare).toHaveBeenCalledWith(input);
    expect(mocks.updateShare).toHaveBeenCalledWith("id", { name: "Renamed" });
    expect(mocks.deleteShare).toHaveBeenCalledWith("id");
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: managedSharesKey });
    expect(managedSharesKey).toEqual(["shares", "managed"]);
  });
  it("leaves the list alone when a change fails", async () => {
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mocks.deleteShare.mockRejectedValueOnce(new Error("offline"));
    await expect(result.current.revoke("id")).rejects.toThrow("offline");
    expect(invalidate).not.toHaveBeenCalled();
  });
  it("cancels an initial empty list request before refreshing after creation", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.listShares
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ items: [{ id: "new" }] });
    const { result } = setup();
    await waitFor(() => expect(mocks.listShares).toHaveBeenCalledOnce());
    await act(async () => {
      await result.current.create(input);
    });
    await waitFor(() => expect(result.current.query.data).toEqual({ items: [{ id: "new" }] }));
    await act(async () => finish({ items: [] }));
    expect(result.current.query.data).toEqual({ items: [{ id: "new" }] });
  });
});
