// @vitest-environment jsdom
import { type AdminUser, ApiClientError } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const ME: AdminUser = {
  username: "ada",
  disabled: false,
  isAdmin: true,
  isYou: true,
  adminByDeployment: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: "2026-11-10T09:00:00.000Z",
};
const GRACE: AdminUser = {
  username: "grace",
  disabled: false,
  isAdmin: false,
  isYou: false,
  adminByDeployment: false,
  createdAt: "2026-02-03T00:00:00.000Z",
  lastLoginAt: null,
};

type Mutation = {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  error: unknown;
};
const mutation = (): Mutation => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null,
});

const mocks = vi.hoisted(() => ({
  list: {
    data: undefined as { available: boolean; users: AdminUser[] } | undefined,
    isLoading: false,
    isError: false,
    error: null as unknown,
    dataUpdatedAt: 1,
  },
  create: undefined as unknown as Mutation,
  update: undefined as unknown as Mutation,
  remove: undefined as unknown as Mutation,
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("./system-page", () => ({
  SystemPage: (props: {
    title: string;
    description: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      <div>{props.actions}</div>
      <div>{props.children}</div>
    </div>
  ),
}));
vi.mock("@/lib/api/system-queries", () => ({
  useAdminUsers: () => mocks.list,
  useAdminCreateUser: () => mocks.create,
  useAdminUpdateUser: () => mocks.update,
  useAdminDeleteUser: () => mocks.remove,
}));

const { UsersPage } = await import("./users-page");

function renderPage(users: AdminUser[], available = true) {
  mocks.list.data = { available, users };
  return render(<UsersPage />);
}

async function openRowMenu(username: string) {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${username}` }));
  return screen.findByRole("menu");
}

/** Runs the mutation's `onSuccess` (or `onError`) as soon as it is called. */
function settle(target: Mutation, outcome: { error?: unknown } = {}) {
  target.mutate.mockImplementation(
    (_input: unknown, options: { onSuccess?: () => void; onError?: (error: unknown) => void }) =>
      outcome.error === undefined ? options.onSuccess?.() : options.onError?.(outcome.error),
  );
}

function resetMocks() {
  mocks.list = {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    dataUpdatedAt: 1,
  };
  mocks.create = mutation();
  mocks.update = mutation();
  mocks.remove = mutation();
}
resetMocks();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetMocks();
});

describe("the list", () => {
  it("shows each user with their badges, last sign-in and when they were added", () => {
    renderPage([ME, { ...GRACE, disabled: true }]);

    expect(screen.getByText("2 users")).toBeTruthy();
    const ada = screen.getByText("ada").closest("tr") as HTMLElement;
    expect(within(ada).getByText("You")).toBeTruthy();
    expect(within(ada).getByText("Admin")).toBeTruthy();
    expect(within(ada).getByText("2026-11-10")).toBeTruthy();
    const grace = screen.getByText("grace").closest("tr") as HTMLElement;
    expect(within(grace).getByText("Disabled")).toBeTruthy();
    expect(within(grace).queryByText("Admin")).toBeNull();
    expect(within(grace).getByText("Never")).toBeTruthy();
    expect(within(grace).getByText("2026-02-03")).toBeTruthy();
  });

  it("offers no actions on the administrator's own row and says why", () => {
    renderPage([ME, GRACE]);

    expect(screen.queryByRole("button", { name: "Actions for ada" })).toBeNull();
    expect(screen.getByRole("button", { name: "Actions for grace" })).toBeTruthy();
    expect(screen.getByText(/You can't disable, demote or remove yourself/)).toBeTruthy();
  });

  it("counts a single user in the singular", () => {
    renderPage([GRACE]);

    expect(screen.getByText("1 user")).toBeTruthy();
    expect(screen.queryByText(/You can't disable/)).toBeNull();
  });

  it("explains a deployment without a local folder instead of an empty list", () => {
    renderPage([], false);

    expect(screen.getByText("No local folder")).toBeTruthy();
    expect(screen.getByText(/Set FDRIVE_STORAGE_ROOT to serve a folder/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect((screen.getByRole("button", { name: "Add user" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("treats a 403 as a refusal, not a deployment without users", () => {
    mocks.list.isError = true;
    mocks.list.error = new ApiClientError("forbidden", "admin only", 403);
    render(<UsersPage />);

    expect(screen.getByText("Administrators only")).toBeTruthy();
    expect(screen.queryByText("No local folder")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports any other failure", () => {
    mocks.list.isError = true;
    mocks.list.error = new ApiClientError("upstream_unavailable", "down", 502);
    render(<UsersPage />);

    expect(screen.getByRole("alert").textContent).toContain("fdrive can't reach the server");
  });

  it("holds the space while loading", () => {
    mocks.list.isLoading = true;
    mocks.list.dataUpdatedAt = 0;
    const { container } = render(<UsersPage />);

    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("adding a user", () => {
  it("adds a user with a trimmed name, a password and the administrator flag", () => {
    settle(mocks.create);
    renderPage([ME]);

    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    const dialog = screen.getByRole("dialog");
    const add = within(dialog).getByRole("button", { name: "Add user" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Username"), { target: { value: " grace " } });
    fireEvent.change(within(dialog).getByLabelText("Password"), {
      target: { value: "hopper-1906" },
    });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Administrator" }));
    fireEvent.click(add);

    expect(mocks.create.mutate).toHaveBeenCalledWith(
      { username: "grace", password: "hopper-1906", isAdmin: true },
      expect.anything(),
    );
    expect(mocks.success).toHaveBeenCalledWith("Added grace.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("explains a name or password the API would refuse before sending it", () => {
    renderPage([ME]);

    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Username"), { target: { value: "a/b" } });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "short" } });

    expect(within(dialog).getByText(/starting with a letter or digit/)).toBeTruthy();
    expect(within(dialog).getByText("Use at least 8 characters.")).toBeTruthy();
    fireEvent.submit(within(dialog).getByLabelText("Username").closest("form") as HTMLElement);
    expect(mocks.create.mutate).not.toHaveBeenCalled();
  });

  it("says when the name is taken", () => {
    mocks.create.isError = true;
    mocks.create.error = new ApiClientError(
      "conflict",
      "a user with this name already exists",
      409,
    );
    renderPage([ME]);

    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    expect(screen.getByText("A user with this name already exists.")).toBeTruthy();
  });

  it("closes without adding anyone", () => {
    renderPage([ME]);

    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.create.mutate).not.toHaveBeenCalled();
  });
});

describe("row actions", () => {
  it("resets a password from its own dialog", async () => {
    settle(mocks.update);
    renderPage([ME, GRACE]);

    await openRowMenu("grace");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset password" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Reset password for grace")).toBeTruthy();
    expect(within(dialog).getByText(/signed out everywhere/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("New password"), {
      target: { value: "new-password" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset password" }));

    expect(mocks.update.mutate).toHaveBeenCalledWith(
      { username: "grace", patch: { password: "new-password" } },
      expect.anything(),
    );
    expect(mocks.success).toHaveBeenCalledWith("Changed the password of grace.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a reset that would be refused from being sent, and shows a refusal", async () => {
    mocks.update.isError = true;
    mocks.update.error = new ApiClientError("not_found", "no such user", 404);
    renderPage([ME, GRACE]);

    await openRowMenu("grace");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset password" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("New password"), { target: { value: "x" } });
    fireEvent.submit(within(dialog).getByLabelText("New password").closest("form") as HTMLElement);

    expect(mocks.update.mutate).not.toHaveBeenCalled();
    expect(within(dialog).getByText("That item could not be found.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables and enables a user", async () => {
    settle(mocks.update);
    const view = renderPage([ME, GRACE]);

    await openRowMenu("grace");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Disable" }));
    expect(mocks.update.mutate).toHaveBeenCalledWith(
      { username: "grace", patch: { disabled: true } },
      expect.anything(),
    );
    expect(mocks.success).toHaveBeenCalledWith("Disabled grace and signed them out.");

    mocks.list.data = { available: true, users: [ME, { ...GRACE, disabled: true }] };
    view.rerender(<UsersPage />);
    await openRowMenu("grace");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Enable" }));
    expect(mocks.update.mutate).toHaveBeenLastCalledWith(
      { username: "grace", patch: { disabled: false } },
      expect.anything(),
    );
    expect(mocks.success).toHaveBeenLastCalledWith("grace can sign in again.");
  });

  it("makes and removes an administrator", async () => {
    settle(mocks.update);
    const view = renderPage([ME, GRACE]);

    await openRowMenu("grace");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Make administrator" }));
    expect(mocks.update.mutate).toHaveBeenCalledWith(
      { username: "grace", patch: { isAdmin: true } },
      expect.anything(),
    );
    expect(mocks.success).toHaveBeenCalledWith("grace is now an administrator.");

    mocks.list.data = { available: true, users: [ME, { ...GRACE, isAdmin: true }] };
    view.rerender(<UsersPage />);
    await openRowMenu("grace");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove administrator" }));
    expect(mocks.update.mutate).toHaveBeenLastCalledWith(
      { username: "grace", patch: { isAdmin: false } },
      expect.anything(),
    );
    expect(mocks.success).toHaveBeenLastCalledWith("grace is no longer an administrator.");
  });

  it("leaves the administrator a deployment names as one", async () => {
    renderPage([ME, { ...GRACE, isAdmin: true, adminByDeployment: true }]);
    expect(
      screen.getByTitle("An administrator through FDRIVE_ADMIN_USERS in the deployment."),
    ).toBeTruthy();
    await openRowMenu("grace");
    const item = await screen.findByRole("menuitem", { name: "Remove administrator" });
    expect(item.getAttribute("aria-disabled") ?? item.getAttribute("data-disabled")).not.toBeNull();
  });

  it("reports a refused change", async () => {
    settle(mocks.update, { error: new ApiClientError("forbidden", "nope", 403) });
    renderPage([ME, GRACE]);

    await openRowMenu("grace");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Disable" }));

    expect(mocks.error).toHaveBeenCalledWith("You don't have permission to do that.");
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("removes a user after a confirmation that their files stay", async () => {
    settle(mocks.remove);
    renderPage([ME, GRACE]);

    await openRowMenu("grace");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = screen.getByRole("alertdialog");
    expect(within(confirm).getByText("Remove grace?")).toBeTruthy();
    expect(within(confirm).getByText(/Their files stay in their folder/)).toBeTruthy();
    expect(within(confirm).getByText(/adding grace again restores their access/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));

    expect(mocks.remove.mutate).toHaveBeenCalledWith("grace", expect.anything());
    expect(mocks.success).toHaveBeenCalledWith("Removed grace. Their files stay in their folder.");
  });

  it("reports a refused removal", async () => {
    settle(mocks.remove, { error: new ApiClientError("forbidden", "nope", 403) });
    renderPage([ME, GRACE]);

    await openRowMenu("grace");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );

    expect(mocks.error).toHaveBeenCalledWith("You don't have permission to do that.");
  });

  it("keeps the user when the removal is cancelled", async () => {
    renderPage([ME, GRACE]);

    await openRowMenu("grace");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );

    expect(mocks.remove.mutate).not.toHaveBeenCalled();
  });
});
