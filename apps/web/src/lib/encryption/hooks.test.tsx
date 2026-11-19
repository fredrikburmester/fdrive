// @vitest-environment jsdom
import type { EncryptionStatus } from "@fdrive/contracts";
import { encryptedSize } from "@fdrive/crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptedEntry, encryptedFolder } from "@/test-fixtures/encryption";

const mocks = vi.hoisted(() => ({
  client: {
    encryptionStatus: vi.fn(),
    enableEncryption: vi.fn(async () => ({})),
    changeEncryptionPassword: vi.fn(async () => ({ ok: true })),
    resetEncryption: vi.fn(async () => ({ ok: true })),
    removeEncryptionDevice: vi.fn(async () => ({ ok: true })),
    encryptedFolder: vi.fn(),
    encryptedEntries: vi.fn(),
  },
}));
vi.mock("@/lib/api/client", () => ({ apiClient: mocks.client }));

const { keyStore } = await import("./keys");
const queries = await import("./queries");
const { useEncryptedSearch } = await import("./search");
const { useDecryptedFile } = await import("./use-decrypted-file");

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(async () => {
  await keyStore.lock();
});
afterEach(() => vi.clearAllMocks());

describe("encryption queries", () => {
  it("hands each status to the key store", async () => {
    mocks.client.encryptionStatus.mockResolvedValue({ enabled: false } satisfies EncryptionStatus);
    const { result } = renderHook(() => queries.useEncryptionStatus(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toEqual({ enabled: false }));
    expect(keyStore.get().status).toBe("off");
  });

  it("changes keys and asks for the status again", async () => {
    mocks.client.encryptionStatus.mockResolvedValue({ enabled: false });
    const Wrapper = wrapper();
    const hooks = renderHook(
      () => ({
        enable: queries.useEnableEncryption(),
        password: queries.useChangeEncryptionPassword(),
        reset: queries.useResetEncryption(),
        device: queries.useRemoveEncryptionDevice(),
      }),
      { wrapper: Wrapper },
    );
    await act(async () => {
      await hooks.result.current.enable.mutateAsync({
        signInPassword: "s",
        recipient: "r",
        passwordKey: "p",
        recoveryKey: "k",
      });
      await hooks.result.current.password.mutateAsync({ signInPassword: "s", passwordKey: "p" });
      await hooks.result.current.reset.mutateAsync({ signInPassword: "s" });
      await hooks.result.current.device.mutateAsync("d");
    });
    expect(mocks.client.enableEncryption).toHaveBeenCalled();
    expect(mocks.client.changeEncryptionPassword).toHaveBeenCalled();
    expect(mocks.client.resetEncryption).toHaveBeenCalledWith({ signInPassword: "s" });
    expect(mocks.client.removeEncryptionDevice).toHaveBeenCalledWith("d");
  });

  it("finds the encrypted folder of a path, and asks nothing without one", async () => {
    const { info } = await encryptedFolder();
    mocks.client.encryptedFolder.mockResolvedValue({ folder: info });
    const { result } = renderHook(() => queries.useEncryptedFolder("/Private/x"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data).toEqual(info));
    renderHook(() => queries.useEncryptedFolder(null), { wrapper: wrapper() });
    expect(mocks.client.encryptedFolder).toHaveBeenCalledTimes(1);
  });
});

describe("useEncryptedSearch", () => {
  it("searches names inside the encrypted folder once unlocked", async () => {
    const { info, folder, identity } = await encryptedFolder();
    const file = await encryptedEntry("/Private", "Budget.xlsx", folder, "file", encryptedSize(3));
    mocks.client.encryptedFolder.mockResolvedValue({ folder: info });
    mocks.client.encryptedEntries.mockResolvedValue({
      entries: [{ path: file.path, kind: "file", size: file.size, modifiedAt: file.modifiedAt }],
      truncated: false,
    });
    await keyStore.unlocked(identity);
    const { result } = renderHook(() => useEncryptedSearch("budget", "/Private", true), {
      wrapper: wrapper(),
    });
    await waitFor(() =>
      expect(result.current.data?.files.map((hit) => hit.name)).toEqual(["Budget.xlsx"]),
    );
  });

  it("finds nothing outside an encrypted folder, or once its key is gone", async () => {
    const { identity, info } = await encryptedFolder();
    mocks.client.encryptedFolder.mockResolvedValue({ folder: null });
    await keyStore.unlocked(identity);
    const outside = renderHook(() => useEncryptedSearch("x", "/Docs", true), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(mocks.client.encryptedFolder).toHaveBeenCalled());
    expect(outside.result.current.data).toBeUndefined();

    mocks.client.encryptedFolder.mockResolvedValue({ folder: info });
    mocks.client.encryptedEntries.mockResolvedValue({ entries: [], truncated: false });
    const spy = vi.spyOn(keyStore, "folder").mockResolvedValueOnce(null);
    const gone = renderHook(() => useEncryptedSearch("x", "/Private", true), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(gone.result.current.data).toEqual({ folders: [], files: [] }));
    spy.mockRestore();
  });
});

describe("useDecryptedFile", () => {
  const entry = {
    name: "a.txt",
    path: "/Private/fe1-x",
    kind: "file" as const,
    size: 5,
    modifiedAt: new Date(0).toISOString(),
    ext: ".txt",
    mime: "text/plain",
  };

  it("does nothing without a file or a key", () => {
    const { result } = renderHook(() => useDecryptedFile(undefined, null, "/u"));
    expect(result.current.status).toBe("idle");
  });

  it("decrypts into an object URL and releases it", async () => {
    const { folder } = await encryptedFolder();
    const revoke = vi.fn();
    const deps = {
      fetchDecrypted: vi.fn(async () => new Blob(["hello"])),
      createObjectUrl: () => "blob:1",
      revokeObjectUrl: revoke,
    };
    const { result, unmount } = renderHook(() => useDecryptedFile(entry, folder, "/u", deps));
    await waitFor(() => expect(result.current).toEqual({ status: "ready", url: "blob:1" }));
    expect(deps.fetchDecrypted).toHaveBeenCalledWith("/u", folder.identity, "text/plain");
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });

  it("says when a file is too large or does not decrypt", async () => {
    const { folder } = await encryptedFolder();
    const big = renderHook(() =>
      useDecryptedFile({ ...entry, size: 600 * 1024 * 1024 }, folder, "/u"),
    );
    expect(big.result.current).toEqual({ status: "too-large", downloadable: true });
    const huge = renderHook(() =>
      useDecryptedFile({ ...entry, size: 3 * 1024 * 1024 * 1024 }, folder, "/u"),
    );
    expect(huge.result.current).toEqual({ status: "too-large", downloadable: false });
    const broken = renderHook(() =>
      useDecryptedFile({ ...entry, mime: null }, folder, "/u", {
        fetchDecrypted: () => Promise.reject(new Error("bad key")),
      }),
    );
    await waitFor(() =>
      expect(broken.result.current).toEqual({ status: "error", message: "bad key" }),
    );
    const odd = renderHook(() =>
      useDecryptedFile(entry, folder, "/v", { fetchDecrypted: () => Promise.reject("x") }),
    );
    await waitFor(() => expect(odd.result.current.status).toBe("error"));
  });

  it("drops a result that arrives after the file changed", async () => {
    const { folder } = await encryptedFolder();
    let finish: (blob: Blob) => void = () => undefined;
    const deps = {
      fetchDecrypted: () =>
        new Promise<Blob>((resolve) => {
          finish = resolve;
        }),
      createObjectUrl: vi.fn(() => "blob:late"),
    };
    const { result, unmount } = renderHook(() => useDecryptedFile(entry, folder, "/u", deps));
    unmount();
    finish(new Blob(["late"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.createObjectUrl).not.toHaveBeenCalled();
    expect(result.current.status).toBe("loading");
    const rejected = {
      fetchDecrypted: () =>
        new Promise<Blob>((_, reject) => setTimeout(() => reject(new Error("late")), 0)),
    };
    const late = renderHook(() => useDecryptedFile(entry, folder, "/w", rejected));
    late.unmount();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(late.result.current.status).toBe("loading");
  });
});
