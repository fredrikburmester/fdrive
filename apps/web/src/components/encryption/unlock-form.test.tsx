// @vitest-environment jsdom
import { ApiClientError, type EncryptionStatus } from "@fdrive/contracts";
import * as crypto from "@fdrive/crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keyStore } from "@/lib/encryption/keys";

const FAST = { workFactor: 10 };

const mocks = vi.hoisted(() => ({
  status: {
    data: undefined as EncryptionStatus | undefined,
    isError: false,
    error: null as unknown,
  },
  change: vi.fn(),
  success: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.success } }));
vi.mock("@/lib/encryption/queries", () => ({
  useEncryptionStatus: () => mocks.status,
  useChangeEncryptionPassword: () => ({ mutateAsync: mocks.change }),
}));
// The default scrypt work factor takes a second per key; tests use a small one.
vi.mock("@fdrive/crypto", async (original) => {
  const actual = await original<typeof import("@fdrive/crypto")>();
  return {
    ...actual,
    passwordKeyFor: (identity: string, password: string) =>
      actual.passwordKeyFor(identity, password, { workFactor: 10 }),
    unlockWithRecovery: vi.fn(actual.unlockWithRecovery),
  };
});

const {
  UnlockForm,
  WRONG_ENCRYPTION_PASSWORD,
  encryptionPasswordErrors,
  recoveryIdentityFrom,
  describeEncryptionError,
} = await import("./unlock-form");

const PASSWORD = "correct horse battery";
let keys: crypto.NewAccountKeys;
let enabled: Extract<EncryptionStatus, { enabled: true }>;

beforeAll(async () => {
  keys = await crypto.createAccountKeys(PASSWORD, FAST);
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
  mocks.status = { data: enabled, isError: false, error: null };
  await keyStore.lock();
  await keyStore.refresh(enabled);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("UnlockForm", () => {
  it("shows a placeholder while the status loads, its error, and nothing when encryption is off", () => {
    mocks.status = { data: undefined, isError: false, error: null };
    const { container, rerender } = render(<UnlockForm />);
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();

    mocks.status = {
      data: undefined,
      isError: true,
      error: new ApiClientError("internal", "boom", 500),
    };
    rerender(<UnlockForm />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Something went wrong on the server. Please try again.",
    );

    mocks.status = { data: { enabled: false }, isError: false, error: null };
    rerender(<UnlockForm />);
    expect(container.textContent).toBe("");
  });

  it("refuses a wrong encryption password, then unlocks with the right one", async () => {
    const onUnlocked = vi.fn();
    render(<UnlockForm className="mt-2" onUnlocked={onUnlocked} />);
    const unlock = screen.getByRole("button", { name: "Unlock" }) as HTMLButtonElement;
    expect(unlock.disabled).toBe(true);

    type("Encryption password", "not the password");
    fireEvent.click(unlock);
    expect(await screen.findByText(WRONG_ENCRYPTION_PASSWORD)).toBeDefined();
    expect(keyStore.get().status).toBe("locked");
    expect(onUnlocked).not.toHaveBeenCalled();

    type("Encryption password", PASSWORD);
    expect(screen.queryByText(WRONG_ENCRYPTION_PASSWORD)).toBeNull();
    fireEvent.submit(screen.getByLabelText("Encryption password").closest("form") as HTMLElement);
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(keyStore.get().status).toBe("unlocked");
    expect(keyStore.identity()).toBe(keys.identity);
    expect((screen.getByLabelText("Encryption password") as HTMLInputElement).value).toBe("");
  });

  it("shows other unlock failures in their own words", async () => {
    const unlock = vi.spyOn(keyStore, "unlock").mockRejectedValueOnce(new Error("No memory"));
    render(<UnlockForm />);
    type("Encryption password", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("No memory")).toBeDefined();
    unlock.mockRestore();
  });

  it("sets a new encryption password with the recovery key from a pasted file", async () => {
    mocks.change.mockResolvedValue({ ok: true });
    const onUnlocked = vi.fn();
    render(<UnlockForm onUnlocked={onUnlocked} />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot encryption password" }));

    const submit = screen.getByRole("button", {
      name: "Set password and unlock",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    type("Recovery key", `# fdrive encryption recovery key\n${keys.recoveryIdentity}\n`);
    type("New encryption password", "a brand new password");
    type("Confirm new encryption password", "a brand new password");
    type("Sign-in password", "sign-in");
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(mocks.change).toHaveBeenCalledOnce();
    const request = mocks.change.mock.calls[0]?.[0] as {
      signInPassword: string;
      passwordKey: string;
    };
    expect(request.signInPassword).toBe("sign-in");
    // The new copy opens with the new password, never sent anywhere itself.
    expect(JSON.stringify(request)).not.toContain("a brand new password");
    await expect(
      crypto.unlockWithPassword(request.passwordKey, "a brand new password", keys.recipient),
    ).resolves.toBe(keys.identity);
    expect(keyStore.identity()).toBe(keys.identity);
    expect(mocks.success).toHaveBeenCalledWith("Encryption password changed.");
  });

  it("refuses a recovery key that is missing or belongs to another key", async () => {
    render(<UnlockForm />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot encryption password" }));
    type("Recovery key", "my key is somewhere");
    type("New encryption password", "a brand new password");
    type("Confirm new encryption password", "a brand new password");
    type("Sign-in password", "sign-in");
    fireEvent.click(screen.getByRole("button", { name: "Set password and unlock" }));
    expect(
      await screen.findByText("Paste the line that starts with AGE-SECRET-KEY-1."),
    ).toBeDefined();

    const other = await crypto.newKeyPair();
    type("Recovery key", other.identity);
    expect(screen.queryByText("Paste the line that starts with AGE-SECRET-KEY-1.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set password and unlock" }));
    expect(await screen.findByText("That recovery key does not open your key.")).toBeDefined();
    expect(mocks.change).not.toHaveBeenCalled();
    expect(keyStore.get().status).toBe("locked");
  });

  it("reads the recovery key from a chosen file and refuses a file without one", async () => {
    render(<UnlockForm />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot encryption password" }));
    const input = screen.getByLabelText("Recovery key file") as HTMLInputElement;
    const field = screen.getByLabelText("Recovery key") as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { files: [new File([`# key\n${keys.recoveryIdentity}\n`], "key.txt")] },
    });
    await waitFor(() => expect(field.value).toBe(keys.recoveryIdentity));

    fireEvent.change(input, { target: { files: [new File(["nothing here"], "notes.txt")] } });
    expect(await screen.findByText("That file holds no recovery key.")).toBeDefined();
    fireEvent.change(input, {
      target: { files: [new File(["x".repeat(20_000)], "large.txt")] },
    });
    expect(await screen.findByText("That file holds no recovery key.")).toBeDefined();
    fireEvent.change(input, { target: { files: [] } });
    type("Recovery key", "typed instead");
    expect(screen.queryByText("That file holds no recovery key.")).toBeNull();
  });

  it("keeps the browser locked when the sign-in password is refused, and goes back", async () => {
    mocks.change.mockRejectedValue(new ApiClientError("unauthorized", "invalid", 401));
    render(<UnlockForm />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot encryption password" }));
    type("Recovery key", keys.recoveryIdentity);
    type("New encryption password", "a brand new password");
    type("Confirm new encryption password", "a brand new password");
    type("Sign-in password", "wrong");
    fireEvent.click(screen.getByRole("button", { name: "Set password and unlock" }));
    expect(await screen.findByText("That sign-in password is not right.")).toBeDefined();
    expect(keyStore.get().status).toBe("locked");

    fireEvent.click(screen.getByRole("button", { name: "Use encryption password" }));
    expect(screen.getByRole("button", { name: "Unlock" })).toBeDefined();
  });

  it("shows a failure to open the recovery copy that is not a wrong key", async () => {
    vi.mocked(crypto.unlockWithRecovery).mockRejectedValueOnce(new Error("Out of memory"));
    render(<UnlockForm />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot encryption password" }));
    type("Recovery key", keys.recoveryIdentity);
    type("New encryption password", "a brand new password");
    type("Confirm new encryption password", "a brand new password");
    type("Sign-in password", "sign-in");
    fireEvent.click(screen.getByRole("button", { name: "Set password and unlock" }));
    expect(await screen.findByText("Out of memory")).toBeDefined();
    expect(mocks.change).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("finds the recovery key in a pasted file", () => {
    expect(recoveryIdentityFrom(`# comment\n  ${keys.recoveryIdentity.toLowerCase()}  \n`)).toBe(
      keys.recoveryIdentity,
    );
    expect(recoveryIdentityFrom("AGE-SECRET-KEY-1 not a key")).toBeNull();
    expect(recoveryIdentityFrom("")).toBeNull();
  });

  it("explains encryption passwords that are short, repeat the sign-in password or differ", () => {
    expect(encryptionPasswordErrors({ password: "", confirm: "", signInPassword: "" })).toEqual({
      password: null,
      confirm: null,
      valid: false,
    });
    expect(
      encryptionPasswordErrors({ password: "short", confirm: "", signInPassword: "x" }),
    ).toEqual({ password: "Use at least 12 characters.", confirm: null, valid: false });
    expect(
      encryptionPasswordErrors({
        password: "sign-in password",
        confirm: "sign-in password",
        signInPassword: "sign-in password",
      }).password,
    ).toBe("Use a different password from the one you sign in with.");
    expect(
      encryptionPasswordErrors({ password: PASSWORD, confirm: "other", signInPassword: "x" })
        .confirm,
    ).toBe("The passwords don't match.");
    expect(
      encryptionPasswordErrors({ password: PASSWORD, confirm: PASSWORD, signInPassword: "" }).valid,
    ).toBe(false);
    expect(
      encryptionPasswordErrors({ password: PASSWORD, confirm: PASSWORD, signInPassword: "x" })
        .valid,
    ).toBe(true);
  });

  it("names a refused sign-in password and other failures", () => {
    expect(describeEncryptionError(new ApiClientError("unauthorized", "no", 401))).toBe(
      "That sign-in password is not right.",
    );
    expect(describeEncryptionError(new Error("Offline"))).toBe("Offline");
  });
});
