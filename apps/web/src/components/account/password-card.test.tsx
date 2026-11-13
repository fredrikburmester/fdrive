// @vitest-environment jsdom
import { ApiClientError, type MeResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeIdentity, makeMe } from "@/test-fixtures/identity";

const mocks = vi.hoisted(() => ({
  me: undefined as MeResponse | undefined,
  change: {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
  },
  success: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.success } }));
vi.mock("@/components/shell/page-header", () => ({ useShellMe: () => ({ data: mocks.me }) }));
vi.mock("@/lib/account/queries", () => ({ useChangePassword: () => mocks.change }));

const { PasswordCard } = await import("./password-card");

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.me = undefined;
  mocks.change = { mutate: vi.fn(), isPending: false, isError: false, error: null };
});

describe("PasswordCard", () => {
  it("stays hidden while the account loads, or when the active login is unknown", () => {
    const { container, rerender } = render(<PasswordCard />);
    expect(container.textContent).toBe("");

    mocks.me = makeMe({ activeIdentityId: "gone" });
    rerender(<PasswordCard />);
    expect(container.textContent).toBe("");
  });

  it("follows the active login, not just the first one", () => {
    mocks.me = makeMe({
      identities: [makeIdentity(), makeIdentity({ id: "two", username: "bob" })],
      activeIdentityId: "two",
    });
    render(<PasswordCard />);

    expect(screen.getByText(/The password bob signs in with/)).toBeTruthy();
  });

  it("changes the local login's password, then clears the form", () => {
    mocks.me = makeMe();
    mocks.change.mutate.mockImplementation((_input, options) => options.onSuccess());
    render(<PasswordCard />);

    expect(screen.getByText(/The password ada signs in with/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Change password" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    type("Current password", "old-secret");
    type("New password", "new-secret");
    type("Confirm new password", "new-secret");
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    expect(mocks.change.mutate).toHaveBeenCalledWith(
      { currentPassword: "old-secret", newPassword: "new-secret" },
      expect.anything(),
    );
    expect(mocks.success).toHaveBeenCalledWith(
      "Password changed. Your other sessions were signed out.",
    );
    for (const label of ["Current password", "New password", "Confirm new password"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
    }
  });

  it("explains a new password the API would refuse and a repeat that differs", () => {
    mocks.me = makeMe();
    render(<PasswordCard />);

    type("Current password", "old-secret");
    type("New password", "short");
    expect(screen.getByText("Use at least 8 characters.")).toBeTruthy();
    type("New password", "new-secret");
    type("Confirm new password", "new-secert");
    expect(screen.getByText("The passwords don't match.")).toBeTruthy();
    fireEvent.submit(screen.getByLabelText("Current password").closest("form") as HTMLElement);

    expect(mocks.change.mutate).not.toHaveBeenCalled();
  });

  it("shows the server's words when the current password is wrong", () => {
    mocks.me = makeMe();
    mocks.change.isError = true;
    mocks.change.error = new ApiClientError(
      "unauthorized",
      "the current password is not right",
      401,
    );
    render(<PasswordCard />);

    expect(screen.getByText("The current password is not right.")).toBeTruthy();
  });
});
