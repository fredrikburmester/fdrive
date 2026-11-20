// @vitest-environment jsdom
import { ApiClientError, type MeResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const { PasswordSection } = await import("./password-section");

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.me = undefined;
  mocks.change = { mutate: vi.fn(), isPending: false, isError: false, error: null };
});

describe("PasswordSection", () => {
  it("stays hidden while the account loads", () => {
    const { container } = render(<PasswordSection />);
    expect(container.textContent).toBe("");
  });

  it("names the signed-in login", () => {
    mocks.me = makeMe({ identity: makeIdentity({ id: "two", username: "bob" }) });
    render(<PasswordSection />);

    // The section is its own sheet, and its name is the page's heading.
    const sheet = screen.getByRole("region", { name: "Password" });
    expect(within(sheet).getByRole("heading", { level: 1, name: "Password" })).toBeTruthy();
    expect(within(sheet).getByText(/The password bob signs in with/)).toBeTruthy();
    // The form's one button changes the password.
    expect(within(sheet).getAllByRole("button")).toHaveLength(1);
    expect(within(sheet).getByRole("button", { name: "Change password" })).toBeTruthy();
  });

  it("says in one line what each field is for", () => {
    mocks.me = makeMe();
    render(<PasswordSection />);

    expect(screen.getByText("The one you sign in with now, to confirm it is you.")).toBeTruthy();
    expect(screen.getByText("At least 8 characters.")).toBeTruthy();
    expect(screen.getByText("The new password once more, to catch a typo.")).toBeTruthy();
  });

  it("says so while the change is sent, and keeps the fields still", () => {
    mocks.me = makeMe();
    mocks.change.isPending = true;
    render(<PasswordSection />);

    const submit = screen.getByRole("button", { name: "Changing…" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    for (const label of ["Current password", "New password", "Confirm new password"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("changes the local login's password, then clears the form", () => {
    mocks.me = makeMe();
    mocks.change.mutate.mockImplementation((_input, options) => options.onSuccess());
    render(<PasswordSection />);

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
    render(<PasswordSection />);

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
    render(<PasswordSection />);

    // The error stands in the row that ends the form, ahead of its button.
    const error = screen.getByText("The current password is not right.");
    const actions = error.closest('[data-slot="setting-actions"]') as HTMLElement;
    expect(actions.lastElementChild).toBe(screen.getByRole("button", { name: "Change password" }));
    expect(actions.firstElementChild?.contains(error)).toBe(true);
  });
});
