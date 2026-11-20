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

const { EncryptionSection } = await import("./encryption-section");

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
  return render(<EncryptionSection />, { wrapper });
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function unlockedWith(status: Extract<EncryptionStatus, { enabled: true }>) {
  mocks.status = { ...mocks.status, data: status };
  await keyStore.unlocked(keys.identity);
}

/** The segments that choose which part of an unlocked sheet shows. */
function parts() {
  return screen.getByRole("group", { name: "Section" });
}

/** Shows one part of an unlocked sheet: Key, Password or Macs. */
function show(part: "Key" | "Password" | "Macs") {
  fireEvent.click(within(parts()).getByRole("button", { name: part }));
}

/** The words of the sheet's status badges, in order. */
function badges(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll('[data-slot="status-badge"]'),
    (badge) => badge.textContent,
  );
}

describe("EncryptionSection", () => {
  it("stays hidden while the account loads, and says so where encrypted folders are off", () => {
    mocks.me = undefined;
    const { container, rerender } = mount();
    expect(container.textContent).toBe("");
    mocks.me = makeMe({ encryptedFolders: false });
    rerender(<EncryptionSection />);
    const sheet = screen.getByRole("region", { name: "Encryption" });
    expect(within(sheet).getByRole("heading", { level: 1, name: "Encryption" })).toBeDefined();
    expect(badges(container)).toEqual([]);
    expect(screen.getByText("Encrypted folders are not available")).toBeDefined();
    expect(screen.getByText("This fdrive server does not offer them.")).toBeDefined();
    expect(screen.queryByLabelText("Encryption password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset encryption" })).toBeNull();
  });

  it("shows a placeholder while the status loads, and a retry when it fails", () => {
    mocks.status = { ...mocks.status, data: undefined };
    const { container, rerender } = mount();
    expect(screen.getByRole("heading", { level: 1, name: "Encryption" })).toBeDefined();
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    // Neither On nor Off until the server has said which.
    expect(badges(container)).toEqual([]);

    mocks.status = {
      ...mocks.status,
      isError: true,
      error: new ApiClientError("internal", "boom", 500),
    };
    rerender(<EncryptionSection />);
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
    const { container } = mount();

    expect(screen.getByRole("heading", { level: 1, name: "Encryption" })).toBeDefined();
    expect(screen.getByText("Folders only your own devices can open.")).toBeDefined();
    expect(badges(container)).toEqual(["Off"]);
    // Nothing to reset before there are keys.
    expect(container.querySelector('[data-slot="detail-sheet-footer"]')).toBeNull();
    expect(screen.getByText(/the server and its administrators cannot open them/)).toBeDefined();
    expect(
      screen.getByText(/A server that has been taken over could change this web app/),
    ).toBeDefined();
    // Every field says in one line what it is for.
    expect(
      screen.getByText("At least 12 characters, and not your sign-in password."),
    ).toBeDefined();
    expect(screen.getByText("The same password once more, to catch a typo.")).toBeDefined();
    expect(screen.getByText("The password you sign in with, to confirm it is you.")).toBeDefined();
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
    expect(shown.getAttribute("data-slot")).toBe("recovery-key");
    expect(screen.getByRole("heading", { level: 2, name: "Recovery key" })).toBeDefined();
    expect(screen.getByText(/it is the only way back into your encrypted folders/)).toBeDefined();
    // The password step is behind it, and its Continue went with it.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(click).toHaveBeenCalledOnce();
    const file = (await created.mock.calls[0]?.[0].text()) ?? "";
    expect(file.startsWith("# fdrive encryption recovery key\n# For: ada\n")).toBe(true);
    expect(file).toContain("in Settings > Encryption.");
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
    const { container } = mount();

    expect(badges(container)).toEqual(["On", "Locked in this browser"]);
    expect(screen.getByRole("heading", { level: 2, name: "Unlock this browser" })).toBeDefined();
    expect(
      screen.getByText(/Enter your encryption password to open encrypted folders here/),
    ).toBeDefined();
    // The parts of an unlocked sheet wait for the key.
    expect(screen.queryByRole("group", { name: "Section" })).toBeNull();
    const footer = container.querySelector('[data-slot="detail-sheet-footer"]') as HTMLElement;
    expect(within(footer).getByRole("button", { name: "Reset encryption" })).toBeDefined();
    type("Encryption password", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(keyStore.get().status).toBe("unlocked"));
    expect(await screen.findByText("Key fingerprint")).toBeDefined();
    expect(badges(container)).toEqual(["On", "Unlocked in this browser"]);
  });

  it("shows the key fingerprint and locks this browser", async () => {
    await unlockedWith(enabled);
    const { container } = mount();

    expect(badges(container)).toEqual(["On", "Unlocked in this browser"]);
    expect(screen.getByRole("heading", { level: 2, name: "Your key" })).toBeDefined();
    expect(
      screen.getByText("This browser holds your key until you lock it or sign out."),
    ).toBeDefined();
    const fingerprint = await crypto.keyFingerprint(keys.recipient);
    const shown = await screen.findByText(fingerprint);
    expect(shown.getAttribute("data-slot")).toBe("key-fingerprint");
    expect(
      screen.getByText("The Mac app shows the same fingerprint once it holds your key."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Lock this browser" }));
    await waitFor(() => expect(keyStore.get().status).toBe("locked"));
    expect(await screen.findByRole("button", { name: "Unlock" })).toBeDefined();
    expect(badges(container)).toEqual(["On", "Locked in this browser"]);
  });

  it("shows one part of an unlocked sheet at a time, the key first", async () => {
    await unlockedWith(enabled);
    mount();

    const pressed = () =>
      within(parts())
        .getAllByRole("button")
        .map((segment) => [segment.textContent, segment.getAttribute("aria-pressed")]);
    expect(pressed()).toEqual([
      ["Key", "true"],
      ["Password", "false"],
      ["Macs", "false"],
    ]);
    expect(screen.getByText("Key fingerprint")).toBeDefined();
    expect(screen.queryByLabelText("New encryption password")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Paired Macs" })).toBeNull();

    show("Password");
    expect(pressed()).toEqual([
      ["Key", "false"],
      ["Password", "true"],
      ["Macs", "false"],
    ]);
    expect(
      screen.getByRole("heading", { level: 2, name: "Change encryption password" }),
    ).toBeDefined();
    expect(screen.getByLabelText("New encryption password")).toBeDefined();
    expect(screen.queryByText("Key fingerprint")).toBeNull();
    expect(screen.queryByRole("button", { name: "Lock this browser" })).toBeNull();

    show("Macs");
    expect(screen.getByRole("heading", { level: 2, name: "Paired Macs" })).toBeDefined();
    expect(screen.queryByLabelText("New encryption password")).toBeNull();

    show("Key");
    expect(screen.getByRole("button", { name: "Lock this browser" })).toBeDefined();
    // The reset stays at the foot of the sheet whichever part shows.
    expect(screen.getByRole("button", { name: "Reset encryption" })).toBeDefined();
  });

  it("lists paired Macs and removes one after it is confirmed", async () => {
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
    show("Macs");

    expect(screen.getByText("Macs that hold a copy of your key.")).toBeDefined();
    const row = screen.getByRole("row", { name: /Ada's MacBook/ });
    expect(within(row).getByText("Ada's MacBook")).toBeDefined();
    expect(within(row).getByText("2026-11-02")).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Paired" })).toBeDefined();
    expect(screen.queryByText("No Mac holds your key.")).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Remove Ada's MacBook" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText('Remove "Ada\'s MacBook"?')).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove Ada's MacBook" }));
    dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/It cannot erase a key the Mac already holds/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(mocks.remove).toHaveBeenCalledWith(
      "0b5d6a8e-3c1f-4d1a-9a57-6f1b6f9f2c11",
      expect.anything(),
    );
    const options = mocks.remove.mock.calls[0]?.[1] as { onError: (error: Error) => void };
    options.onError(new Error("Offline"));
    expect(mocks.error).toHaveBeenCalledWith("Offline");
  });

  it("says when no Mac holds the key", async () => {
    await unlockedWith(enabled);
    mount();
    show("Macs");

    expect(screen.getByRole("heading", { level: 2, name: "Paired Macs" })).toBeDefined();
    expect(screen.getByText("No Mac holds your key.")).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("changes the encryption password without sending it", async () => {
    mocks.change
      .mockRejectedValueOnce(new ApiClientError("unauthorized", "invalid", 401))
      .mockResolvedValueOnce({ ok: true });
    await unlockedWith(enabled);
    mount();
    show("Password");

    expect(
      screen.getByText("Your encrypted folders and paired Macs keep working as before."),
    ).toBeDefined();
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

    // The reset stands apart, at the foot of the sheet, beside what it destroys and what it keeps.
    const footer = view.container.querySelector('[data-slot="detail-sheet-footer"]') as HTMLElement;
    expect(
      within(footer).getByText(/every encrypted folder becomes unreadable for good/),
    ).toBeDefined();
    expect(within(footer).getByText(/Your other files are not touched/)).toBeDefined();
    expect(within(footer).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(footer).getByRole("button", { name: "Reset encryption" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/Every encrypted folder becomes unreadable for good/),
    ).toBeDefined();
    expect(mocks.reset.mutate).not.toHaveBeenCalled();
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
    view.rerender(<EncryptionSection />);
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
    view.rerender(<EncryptionSection />);
    expect(within(dialog).getByRole("button", { name: "Resetting…" })).toBeDefined();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });
});
