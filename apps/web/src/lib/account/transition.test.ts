// @vitest-environment jsdom
import type { MeResponse } from "@fdrive/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  accountTransition,
  createAccountTransitionStore,
  transitionAccount,
  useAccountTransition,
} from "./transition";

const ME: MeResponse = {
  account: { id: "a", displayName: "Ada" },
  identities: [],
  activeIdentityId: "i",
  isAdmin: false,
};

describe("account transition", () => {
  it("cancels before mutation and before clearing, seeds me, then navigates", async () => {
    const client = new QueryClient();
    const store = createAccountTransitionStore();
    const order: string[] = [];
    vi.spyOn(client, "cancelQueries").mockImplementation(async () => {
      order.push("cancel");
    });
    const clear = client.clear.bind(client);
    vi.spyOn(client, "clear").mockImplementation(() => {
      order.push("clear");
      clear();
    });
    client.setQueryData(["private"], "old");
    const unsubscribe = store.subscribe(() => {
      order.push(store.getSnapshot().pending ? "mask" : "reveal");
    });
    await transitionAccount(
      client,
      async () => {
        order.push("request");
        return ME;
      },
      (href) => {
        expect(client.getQueryData(["private"])).toBeUndefined();
        expect(client.getQueryData(["auth", "me"])).toEqual(ME);
        expect(href).toBe("/files/docs");
        order.push("navigate");
      },
      "/files/docs",
      store,
    );
    expect(order).toEqual(["mask", "cancel", "request", "cancel", "clear", "navigate", "reveal"]);
    expect(store.getSnapshot()).toEqual({ pending: false, generation: 1 });
    unsubscribe();
  });

  it("late uncancellable responses cannot refill a cleared key", async () => {
    const client = new QueryClient();
    let complete: ((value: string) => void) | undefined;
    const old = client
      .fetchQuery({
        queryKey: ["listing"],
        queryFn: () =>
          new Promise<string>((resolve) => {
            complete = resolve;
          }),
      })
      .catch(() => {});
    await transitionAccount(
      client,
      async () => ME,
      () => {},
      undefined,
      createAccountTransitionStore(),
    );
    client.setQueryData(["listing"], "new login");
    complete?.("old login");
    await old;
    await Promise.resolve();
    expect(client.getQueryData(["listing"])).toBe("new login");
  });

  it("restores old state on error and rejects competing mutations", async () => {
    const client = new QueryClient();
    client.setQueryData(["auth", "me"], ME);
    const store = createAccountTransitionStore();
    const navigate = vi.fn();
    await expect(
      transitionAccount(
        client,
        async () => {
          expect(() => store.begin()).toThrow("already in progress");
          throw new Error("conflict");
        },
        navigate,
        undefined,
        store,
      ),
    ).rejects.toThrow("conflict");
    expect(store.getSnapshot()).toEqual({ pending: false, generation: 0 });
    expect(client.getQueryData(["auth", "me"])).toEqual(ME);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("notifies React subscribers and removes listeners", () => {
    const { result, unmount } = renderHook(useAccountTransition);
    act(() => accountTransition.begin());
    expect(result.current.pending).toBe(true);
    act(() => accountTransition.finish(false));
    expect(result.current.pending).toBe(false);
    unmount();
    const store = createAccountTransitionStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.begin();
    store.finish(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
