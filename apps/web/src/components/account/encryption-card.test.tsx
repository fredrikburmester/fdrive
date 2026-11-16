// @vitest-environment jsdom
import { ApiClientError, type EncryptionStatus, type MeResponse } from "@fdrive/contracts";
import * as crypto from "@fdrive/crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keyStore } from "@/lib/encryption/keys";
import { makeMe } from "@/test-fixtures/identity";

const mocks = vi.hoisted(() => ({
  me: undefined as MeResponse | undefined,
  status: {
    data: undefined as EncryptionStatus | undefined,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  enable: vi.fn(),
  change: vi.fn(),
  remove: vi.fn(),
  reset: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
  },
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/components/shell/page-header", () => ({ useShellMe: () => ({ data: mocks.me }) }));
vi.mock("@/lib/encryption/queries", () => ({
  useEncryptionStatus: () => mocks.status,
  useEnableEncryption: () => ({ mutateAsync: mocks.enable }),
  useChangeEncryptionPassword: () => ({ mutateAsync: mocks.change }),
  useRemoveEncryptionDevice: () => ({ mutate: mocks.remove }),
  useResetEncryption: () => mocks.reset,
}));
// The default scrypt work factor takes a second per key; tests use a small one.
vi.mock("@fdrive/crypto", async (original) => {
  const actual = await original<typeof import("@fdrive/crypto")>();
  return {
    ...actual,
    createAccountKeys: vi.fn((password: string) =>
      actual.createAccountKeys(password, { workFactor: 10 }),
    ),
    passwordKeyFor: (identity: string, password: string) =>
      actual.passwordKeyFor(identity, password, { workFactor: 10 }),
  };
});

const { EncryptionCard } = await import("./encryption-card");

const PASSWORD = "correct horse battery";
let keys: crypto.NewAccountKeys;
let enabled: Extract<EncryptionStatus, { enabled: true }>;

beforeAll(async () => {
  keys = await crypto.createAccountKeys(PASSWORD, { workFactor: 10 });
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
  mocks.me = makeMe();
  mocks.status = {
    data: { enabled: false },
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
  mocks.reset = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null };
  await keyStore.refresh({ enabled: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

function mount() {
  return render(<EncryptionCard />, { wrapper });
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function unlockedWith(status: Extract<EncryptionStatus, { enabled: true }>) {
  mocks.status = { ...mocks.status, data: status };
  await keyStore.unlocked(keys.identity);
}

describe("EncryptionCard", () => {
  it("stays hidden while the account loads and where encrypted folders are off", () => {
    mocks.me = undefined;
    const { container, rerender } = mount();
    expect(container.textContent).toBe("");
    mocks.me = makeMe({ encryptedFolders: false });
    rerender(<EncryptionCard />);
    expect(container.textContent).toBe("");
  });

  it("shows a placeholder while the status loads, and a retry when it fails", () => {
    mocks.status = { ...mocks.status, data: undefined };
    const { container, rerender } = mount();
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();

    mocks.status = {
      ...mocks.status,
      isError: true,
      error: new ApiClientError("internal", "boom", 500),
    };
    rerender(<EncryptionCard />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Something went wrong on the server. Please try again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.status.refetch).toHaveBeenCalledOnce();
  });

  it("turns encryption on once the recovery key is saved and pasted back", async () => {
    const created = vi.fn((_blob: Blob) => "blob:recovery");
    // jsdom has no object URLs; the download revokes its URL after a second, so both stay.
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const clipboard = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboard },
      configurable: true,
    });
    mocks.enable.mockResolvedValue(enabled);
    mount();

    expect(screen.getByText(/the server and its administrators cannot open them/)).toBeDefined();
    expect(
      screen.getByText(/A server that has been taken over could change this web app/),
    ).toBeDefined();
    const next = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    type("Encryption password", "short");
    expect(screen.getByText("Use at least 12 characters.")).toBeDefined();
    type("Encryption password", "my sign-in password");
    type("Confirm encryption password", "my sign-in password");
    type("Sign-in password", "my sign-in password");
    expect(
      screen.getByText("Use a different password from the one you sign in with."),
    ).toBeDefined();
    expect(next.disabled).toBe(true);
    type("Encryption password", PASSWORD);
    type("Confirm encryption password", PASSWORD);
    expect(next.disabled).toBe(false);
    fireEvent.click(next);

    const shown = await screen.findByText(/^AGE-SECRET-KEY-1/);
    const recoveryIdentity = shown.textContent ?? "";
    expect(crypto.isIdentity(recoveryIdentity)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(click).toHaveBeenCalledOnce();
    const file = (await created.mock.calls[0]?.[0].text()) ?? "";
    expect(file.startsWith("# fdrive encryption recovery key\n# For: ada\n")).toBe(true);
    expect(file.endsWith(`\n${recoveryIdentity}\n`)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(clipboard).toHaveBeenCalledWith(recoveryIdentity);

    const finish = screen.getByRole("button", { name: "Turn on encryption" }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    type("Paste your recovery key", "something else");
    expect(screen.getByText("Paste the line that starts with AGE-SECRET-KEY-1.")).toBeDefined();
    type("Paste your recovery key", keys.recoveryIdentity);
    expect(screen.getByText("That is not the recovery key above.")).toBeDefined();
    type("Paste your recovery key", file);
    expect(finish.disabled).toBe(false);
    fireEvent.click(finish);

    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Encryption is on."));
    const request = mocks.enable.mock.calls[0]?.[0] as Record<string, string>;
    expect(Object.keys(request).sort()).toEqual([
      "passwordKey",
      "recipient",
      "recoveryKey",
      "signInPassword",
    ]);
    expect(request.signInPassword).toBe("my sign-in password");
    // Neither the encryption password nor the recovery key leaves the browser.
    expect(JSON.stringify(request)).not.toContain(PASSWORD);
    expect(JSON.stringify(request)).not.toContain(recoveryIdentity);
    const identity = keyStore.identity() ?? "";
    expect(keyStore.get()).toEqual({ status: "unlocked", recipient: request.recipient });
    await expect(
      crypto.unlockWithPassword(request.passwordKey ?? "", PASSWORD, request.recipient ?? ""),
    ).resolves.toBe(identity);
    await expect(
      crypto.unlockWithRecovery(
        request.recoveryKey ?? "",
        recoveryIdentity,
        request.recipient ?? "",
      ),
    ).resolves.toBe(identity);

    click.mockRestore();
  });

  it("asks for the sign-in password again when it was refused, and can start over", async () => {
    mocks.enable
      .mockRejectedValueOnce(new ApiClientError("unauthorized", "invalid", 401))
      .mockResolvedValueOnce(enabled);
    mount();
    type("Encryption password", PASSWORD);
    type("Confirm encryption password", PASSWORD);
    type("Sign-in password", "wrong");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const shown = await screen.findByText(/^AGE-SECRET-KEY-1/);
    type("Paste your recovery key", shown.textContent ?? "");
    fireEvent.click(screen.getByRole("button", { name: "Turn on encryption" }));

    expect(await screen.findByText("That sign-in password is not right.")).toBeDefined();
    const finish = screen.getByRole("button", { name: "Turn on encryption" }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    type("Sign-in password", PASSWORD);
    expect(
      screen.getByText("Use a different password from the one you sign in with."),
    ).toBeDefined();
    expect(finish.disabled).toBe(true);
    type("Sign-in password", "right");
    fireEvent.click(finish);
    await waitFor(() => expect(mocks.enable).toHaveBeenCalledTimes(2));
    expect(mocks.enable.mock.calls[1]?.[0]).toMatchObject({ signInPassword: "right" });
    await waitFor(() => expect(keyStore.get().status).toBe("unlocked"));
  });

  it("starts over from the recovery key, and shows a failure to make keys", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
      configurable: true,
    });
    mount();
    type("Encryption password", PASSWORD);
    type("Confirm encryption password", PASSWORD);
    type("Sign-in password", "sign-in");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/^AGE-SECRET-KEY-1/);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "This browser did not copy the key. Download it instead.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect((screen.getByLabelText("Encryption password") as HTMLInputElement).value).toBe("");

    vi.mocked(crypto.createAccountKeys).mockRejectedValueOnce(new Error("No randomness"));
    type("Encryption password", PASSWORD);
    type("Confirm encryption password", PASSWORD);
    type("Sign-in password", "sign-in");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("No randomness")).toBeDefined();
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it("asks a locked browser for the encryption password and still offers a reset", async () => {
    mocks.status = { ...mocks.status, data: enabled };
    await keyStore.refresh(enabled);
    mount();

    expect(
      screen.getByText(/Enter your encryption password to open encrypted folders here/),
    ).toBeDefined();
    type("Encryption password", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(keyStore.get().status).toBe("unlocked"));
    expect(await screen.findByText("Key fingerprint")).toBeDefined();
  });

  it("shows the key fingerprint, paired Macs and locks this browser", async () => {
    await unlockedWith({
      ...enabled,
      devices: [
        {
          id: "0b5d6a8e-3c1f-4d1a-9a57-6f1b6f9f2c11",
          name: "Ada's MacBook",
          createdAt: "2026-11-02T09:00:00.000Z",
        },
      ],
    });
    mount();

    const fingerprint = await crypto.keyFingerprint(keys.recipient);
    expect(await screen.findByText(fingerprint)).toBeDefined();
    expect(screen.getByText("Ada's MacBook")).toBeDefined();
    expect(screen.getByText("Paired 2026-11-02")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Remove Ada's MacBook" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/It cannot erase a key the Mac already holds/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(mocks.remove).toHaveBeenCalledWith(
      "0b5d6a8e-3c1f-4d1a-9a57-6f1b6f9f2c11",
      expect.anything(),
    );
    const options = mocks.remove.mock.calls[0]?.[1] as { onError: (error: Error) => void };
    options.onError(new Error("Offline"));
    expect(mocks.error).toHaveBeenCalledWith("Offline");

    fireEvent.click(screen.getByRole("button", { name: "Lock this browser" }));
    await waitFor(() => expect(keyStore.get().status).toBe("locked"));
  });

  it("says when no Mac holds the key", async () => {
    await unlockedWith(enabled);
    mount();
    expect(screen.getByText("No Mac holds your key.")).toBeDefined();
  });

  it("changes the encryption password without sending it", async () => {
    mocks.change
      .mockRejectedValueOnce(new ApiClientError("unauthorized", "invalid", 401))
      .mockResolvedValueOnce({ ok: true });
    await unlockedWith(enabled);
    mount();

    const submit = screen.getByRole("button", {
      name: "Change encryption password",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    type("New encryption password", "a brand new password");
    type("Confirm new encryption password", "a brand new password");
    type("Sign-in password", "wrong");
    fireEvent.click(submit);
    expect(await screen.findByText("That sign-in password is not right.")).toBeDefined();

    type("Sign-in password", "sign-in");
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Encryption password changed."));
    const request = mocks.change.mock.calls[1]?.[0] as {
      signInPassword: string;
      passwordKey: string;
    };
    expect(request.signInPassword).toBe("sign-in");
    expect(JSON.stringify(request)).not.toContain("a brand new password");
    await expect(
      crypto.unlockWithPassword(request.passwordKey, "a brand new password", keys.recipient),
    ).resolves.toBe(keys.identity);
    expect((screen.getByLabelText("New encryption password") as HTMLInputElement).value).toBe("");
  });

  it("resets encryption only with the sign-in password, after saying what is lost", async () => {
    await unlockedWith(enabled);
    const view = mount();

    fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/Every encrypted folder becomes unreadable for good/),
    ).toBeDefined();
    const confirm = within(dialog).getByRole("button", {
      name: "Reset encryption",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Sign-in password"), {
      target: { value: "sign-in" },
    });
    fireEvent.click(confirm);
    expect(mocks.reset.mutate).toHaveBeenCalledWith(
      { signInPassword: "sign-in" },
      expect.anything(),
    );

    mocks.reset = {
      ...mocks.reset,
      isError: true,
      error: new ApiClientError("unauthorized", "x", 401),
    };
    view.rerender(<EncryptionCard />);
    expect(within(dialog).getByText("That sign-in password is not right.")).toBeDefined();

    const options = mocks.reset.mutate.mock.calls[0]?.[1] as { onSuccess: () => void };
    options.onSuccess();
    expect(mocks.success).toHaveBeenCalledWith("Encryption was reset.");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("closes the reset dialog on Cancel, but not while a reset runs", async () => {
    await unlockedWith(enabled);
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
    let dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.reset.reset).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
    dialog = await screen.findByRole("alertdialog");
    mocks.reset = { ...mocks.reset, isPending: true };
    view.rerender(<EncryptionCard />);
    expect(within(dialog).getByRole("button", { name: "Resetting…" })).toBeDefined();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });
});
