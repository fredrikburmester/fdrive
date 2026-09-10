// @vitest-environment jsdom
import type { MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { useUploadStore } from "@/lib/upload/store";
import { accountTransition } from "./transition";
import { useIdentityActions } from "./use-identities";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const me: MeResponse = {
  account: { id: "account", displayName: "Ada" },
  identities: [],
  activeIdentityId: "identity",
  isAdmin: false,
};
function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, ...renderHook(useIdentityActions, { wrapper }) };
}
afterEach(() => {
  vi.restoreAllMocks();
  push.mockClear();
  accountTransition.finish(false);
});

it("links without storing request credentials in either cache", async () => {
  const request = {
    credential: { username: "ada", password: "sensitive test value", otp: "123456" },
    currentCredential: { password: "owner value" },
  };
  const link = vi.spyOn(apiClient, "linkIdentity").mockResolvedValue(me);
  const { result, client } = setup();
  await act(async () => {
    expect(await result.current.link(request)).toBe(true);
  });
  expect(link).toHaveBeenCalledWith(request);
  expect(client.getMutationCache().getAll()).toEqual([]);
  expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(
    request.credential.password,
  );
  expect(push).toHaveBeenCalledWith("/files");
});

it("reports failures, clears feedback and preserves old cache", async () => {
  vi.spyOn(apiClient, "linkIdentity").mockRejectedValue(new Error("Could not link login"));
  const { result, client } = setup();
  client.setQueryData(["private"], "keep");
  await act(async () => {
    expect(
      await result.current.link({
        credential: { username: "ada", password: "temporary" },
        currentCredential: { password: "mine" },
      }),
    ).toBe(false);
  });
  expect(result.current.error).toBe("Could not link login");
  expect(client.getQueryData(["private"])).toBe("keep");
  expect(client.getMutationCache().getAll()).toEqual([]);
  act(() => result.current.resetError());
  expect(result.current.error).toBeNull();
});

it("cancels removed identity uploads only after successful unlink", async () => {
  const unlink = vi
    .spyOn(apiClient, "unlinkIdentity")
    .mockRejectedValueOnce(new Error("last identity"))
    .mockResolvedValueOnce(me);
  const cancel = vi.spyOn(useUploadStore.getState(), "cancelIdentity");
  const { result } = setup();
  await act(async () => {
    await result.current.unlink("removed", { currentCredential: { password: "mine" } });
  });
  expect(cancel).not.toHaveBeenCalled();
  await act(async () => {
    expect(
      await result.current.unlink("removed", { currentCredential: { password: "mine" } }),
    ).toBe(true);
  });
  expect(unlink).toHaveBeenCalledWith("removed", { currentCredential: { password: "mine" } });
  expect(cancel).toHaveBeenCalledWith("removed");
});

it("switches to deliberate target and exposes rejected switch errors", async () => {
  const change = vi
    .spyOn(apiClient, "switchIdentity")
    .mockResolvedValueOnce(me)
    .mockRejectedValueOnce(new Error("denied"));
  const { result } = setup();
  await act(async () => {
    await result.current.switch("identity", "/view/file");
  });
  expect(change).toHaveBeenCalledWith("identity");
  expect(push).toHaveBeenCalledWith("/view/file");
  await act(async () => {
    await expect(result.current.switch("other")).rejects.toThrow("Could not switch");
  });
  expect(result.current.error).toBe("denied");
});
