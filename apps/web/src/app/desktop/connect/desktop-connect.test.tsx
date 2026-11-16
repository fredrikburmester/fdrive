// @vitest-environment jsdom
import { ApiClientError, type EncryptionStatus } from "@fdrive/contracts";
import * as crypto from "@fdrive/crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { keyStore } from "@/lib/encryption/keys";
import { makeIdentity, makeMe } from "@/test-fixtures/identity";
import { DesktopConnect } from "./desktop-connect";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const identity = makeIdentity({ username: "alice" });
const me = makeMe({ identity, storageName: "Personal" });
function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  vi.spyOn(apiClient, "me").mockResolvedValue(me);
  render(
    <QueryClientProvider client={client}>
      <DesktopConnect requestId="request" initialMe={me} />
    </QueryClientProvider>,
  );
  return client;
}
function pairing(supportsWrites?: true) {
  return vi.spyOn(apiClient, "desktopPairing").mockResolvedValue({
    deviceName: "Mac",
    code: "ABCD1234",
    expiresAt: new Date().toISOString(),
    approved: false,
    ...(supportsWrites ? { supportsWrites } : {}),
  });
}
it("defaults a writable Mac to read and sends only the access chosen", async () => {
  pairing(true);
  const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
  mount();
  const access = await screen.findByRole("combobox", { name: "Access" });
  expect((access as HTMLSelectElement).value).toBe("read");
  fireEvent.change(access, { target: { value: "full" } });
  fireEvent.change(access, { target: { value: "read" } });
  fireEvent.change(access, { target: { value: "full" } });
  fireEvent.click(screen.getByRole("button", { name: "Allow this Mac" }));
  await screen.findByText("Connection approved");
  expect(approve).toHaveBeenCalledWith("request", "full");
});
it("connects a read-only Mac to the signed-in login without offering writes", async () => {
  pairing();
  const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
  mount();
  await screen.findByRole("button", { name: "Allow this Mac" });
  expect(screen.getByText("Personal")).toBeDefined();
  expect(screen.getByText("alice")).toBeDefined();
  expect(screen.queryByRole("combobox", { name: "Access" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Allow this Mac" }));
  await screen.findByText("Connection approved");
  expect(approve).toHaveBeenCalledWith("request", "read");
  expect(screen.queryByRole("button", { name: "Allow this Mac" })).toBeNull();
});
it("keeps approval failures visible and prevents expired requests from being approved", async () => {
  const info = pairing();
  vi.spyOn(apiClient, "approveDesktopPairing").mockRejectedValue(
    new ApiClientError("not_found", "Request expired", 404),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Allow this Mac" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBeTruthy());
  cleanup();
  info.mockRejectedValue(new ApiClientError("not_found", "Request expired", 404));
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Allow this Mac" })).toBeNull();
});
it("refreshes the login's names in an open approval screen as plain text", async () => {
  pairing();
  const client = mount();
  await screen.findByText("Personal");
  vi.spyOn(apiClient, "me").mockResolvedValue({ ...me, storageName: "<b>Home storage</b>" });
  await client.invalidateQueries({ queryKey: ["auth", "me"] });
  await waitFor(() => expect(screen.getByText("<b>Home storage</b>")).toBeDefined());
  expect(document.querySelector("b")).toBeNull();
});

describe("a Mac that can take the encryption key", () => {
  const PASSWORD = "correct horse battery";
  const nonce = "pairing-nonce";
  let keys: crypto.NewAccountKeys;
  let device: crypto.KeyPair;
  let enabled: EncryptionStatus;

  beforeAll(async () => {
    keys = await crypto.createAccountKeys(PASSWORD, { workFactor: 10 });
    device = await crypto.newKeyPair();
    enabled = {
      enabled: true,
      recipient: keys.recipient,
      passwordKey: keys.passwordKey,
      recoveryKey: keys.recoveryKey,
      devices: [],
      createdAt: "2026-11-16T10:00:00.000Z",
    };
  });

  beforeEach(async () => {
    await keyStore.lock();
    await keyStore.refresh({ enabled: false });
  });

  function keyPairing(extra: { nonce?: string } = { nonce }) {
    return vi.spyOn(apiClient, "desktopPairing").mockResolvedValue({
      deviceName: "Mac",
      code: "SERV-ERCO-DE00-0000",
      expiresAt: new Date().toISOString(),
      approved: false,
      deviceRecipient: device.recipient,
      ...extra,
    });
  }

  async function expectOwnCode() {
    const shown = await screen.findByRole("status", { name: "Connection code" });
    const expected = await crypto.pairingCode(device.recipient, nonce);
    await waitFor(() => expect(shown.textContent).toBe(expected));
    expect(screen.queryByText("SERV-ERCO-DE00-0000")).toBeNull();
  }

  it("shows the code it computes itself and approves without a key while encryption is off", async () => {
    keyPairing();
    const status = vi.spyOn(apiClient, "encryptionStatus").mockResolvedValue({ enabled: false });
    const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
    mount();
    await expectOwnCode();
    await waitFor(() => expect(status).toHaveBeenCalled());
    const allow = screen.getByRole("button", { name: "Allow this Mac" }) as HTMLButtonElement;
    await waitFor(() => expect(allow.disabled).toBe(false));
    fireEvent.click(allow);
    await screen.findByText("Connection approved");
    expect(approve).toHaveBeenCalledWith("request", "read");
  });

  it("gives an unlocked browser's key to the Mac, encrypted to its device key", async () => {
    keyPairing();
    vi.spyOn(apiClient, "encryptionStatus").mockResolvedValue(enabled);
    const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
    await keyStore.unlocked(keys.identity);
    mount();
    await expectOwnCode();
    expect(
      await screen.findByText(/This Mac also gets a copy of your encryption key/),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Allow this Mac" }));
    await screen.findByText("Connection approved");

    const [, mode, deviceKey] = approve.mock.calls[0] ?? [];
    expect(mode).toBe("read");
    expect(deviceKey).not.toContain(keys.identity);
    await expect(
      crypto.unlockWithDevice(deviceKey ?? "", device.identity, keys.recipient),
    ).resolves.toBe(keys.identity);
  });

  it("asks a locked browser to unlock first, then sends the key", async () => {
    keyPairing();
    vi.spyOn(apiClient, "encryptionStatus").mockResolvedValue(enabled);
    const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
    mount();
    expect(await screen.findByText(/stay locked until you connect it again/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Encryption password"), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(
      await screen.findByText(/This Mac also gets a copy of your encryption key/),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Allow this Mac" }));
    await screen.findByText("Connection approved");
    expect(approve.mock.calls[0]?.[2]).toEqual(expect.any(String));
  });

  it("lets a locked browser approve without the key", async () => {
    keyPairing();
    vi.spyOn(apiClient, "encryptionStatus").mockResolvedValue(enabled);
    const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
    mount();
    await screen.findByText(/stay locked until you connect it again/);
    fireEvent.click(screen.getByRole("button", { name: "Allow this Mac" }));
    await screen.findByText("Connection approved");
    expect(approve).toHaveBeenCalledWith("request", "read");
  });

  it("treats a recipient without a nonce as a Mac that cannot take the key", async () => {
    keyPairing({});
    const status = vi.spyOn(apiClient, "encryptionStatus").mockResolvedValue(enabled);
    const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
    await keyStore.unlocked(keys.identity);
    mount();
    const shown = await screen.findByRole("status", { name: "Connection code" });
    expect(shown.textContent).toBe("SERV-ERCO-DE00-0000");
    fireEvent.click(screen.getByRole("button", { name: "Allow this Mac" }));
    await screen.findByText("Connection approved");
    expect(approve).toHaveBeenCalledWith("request", "read");
    expect(status).not.toHaveBeenCalled();
  });

  it("checks the code but sends no key where the installation has no encrypted folders", async () => {
    keyPairing();
    const status = vi.spyOn(apiClient, "encryptionStatus").mockResolvedValue(enabled);
    const approve = vi.spyOn(apiClient, "approveDesktopPairing").mockResolvedValue({ ok: true });
    await keyStore.unlocked(keys.identity);
    const plain = { ...me, encryptedFolders: false };
    vi.spyOn(apiClient, "me").mockResolvedValue(plain);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DesktopConnect requestId="request" initialMe={plain} />
      </QueryClientProvider>,
    );
    await expectOwnCode();
    fireEvent.click(screen.getByRole("button", { name: "Allow this Mac" }));
    await screen.findByText("Connection approved");
    expect(approve).toHaveBeenCalledWith("request", "read");
    expect(status).not.toHaveBeenCalled();
  });
});
