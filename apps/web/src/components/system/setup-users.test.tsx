// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setupUserInventory = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { setupUserInventory } }));

const { SetupUsers } = await import("./setup-users");

function fillCredentials() {
  fireEvent.change(screen.getByLabelText("SFTPGo admin username"), {
    target: { value: "administrator" },
  });
  fireEvent.change(screen.getByLabelText("SFTPGo admin password"), {
    target: { value: "admin-secret" },
  });
}

beforeEach(() => {
  setupUserInventory.mockReset();
});
afterEach(cleanup);

describe("SetupUsers", () => {
  it("uses credentials only for the requested page, renders redacted users, and forgets them", async () => {
    setupUserInventory.mockResolvedValue({
      ok: true,
      users: [{ username: "alice", status: "enabled" }],
      nextOffset: null,
    });
    render(<SetupUsers />);

    fillCredentials();
    expect(setupUserInventory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "List users" }));

    await waitFor(() =>
      expect(setupUserInventory).toHaveBeenCalledWith({
        username: "administrator",
        password: "admin-secret",
        limit: 50,
        offset: 0,
      }),
    );
    expect(screen.getByText("alice", { exact: true })).toBeTruthy();
    expect(screen.getByText("enabled", { exact: true })).toBeTruthy();
    expect(screen.queryByText("admin-secret")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Forget credentials" }));
    expect((screen.getByLabelText("SFTPGo admin username") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("SFTPGo admin password") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "List users" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it.each([
    ["denied", "SFTPGo denied user discovery"],
    ["unavailable", "User discovery is unavailable"],
  ] as const)("makes %s discovery safe to skip", async (reason, message) => {
    setupUserInventory.mockResolvedValue({ ok: false, reason });
    render(<SetupUsers />);

    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "List users" }));

    expect((await screen.findByRole("status")).textContent).toContain(message);
  });

  it("uses the returned offset for the next bounded page", async () => {
    setupUserInventory
      .mockResolvedValueOnce({
        ok: true,
        users: [{ username: "alice", status: "enabled" }],
        nextOffset: 50,
      })
      .mockResolvedValueOnce({
        ok: true,
        users: [{ username: "bob", status: "disabled" }],
        nextOffset: null,
      });
    render(<SetupUsers />);

    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "List users" }));
    await screen.findByRole("button", { name: "Next page" });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    await waitFor(() =>
      expect(setupUserInventory).toHaveBeenLastCalledWith({
        username: "administrator",
        password: "admin-secret",
        limit: 50,
        offset: 50,
      }),
    );
    expect(screen.getByText("bob", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });
});
