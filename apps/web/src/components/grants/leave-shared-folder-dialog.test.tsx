// @vitest-environment jsdom
import { ApiClientError, type ReceivedGrant } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const TRIP: ReceivedGrant = {
  id: "00000000-0000-4000-8000-0000000000b1",
  owner: "alice",
  name: "Trip",
  path: "/Shared with me/Trip",
  access: "read",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const mocks = vi.hoisted(() => ({
  leave: { mutate: vi.fn() },
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/lib/grants/queries", () => ({ useLeaveGrant: () => mocks.leave }));

const { LeaveSharedFolderDialog } = await import("./leave-shared-folder-dialog");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("renders nothing until a folder is chosen", () => {
  render(<LeaveSharedFolderDialog grant={null} onClose={vi.fn()} />);

  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("leaves after a confirmation that names the owner and says nothing changes", () => {
  const onClose = vi.fn();
  mocks.leave.mutate.mockImplementation((_id, options) => options.onSuccess());
  render(<LeaveSharedFolderDialog grant={TRIP} onClose={onClose} />);

  expect(screen.getByText("Leave Trip?")).toBeTruthy();
  expect(
    screen.getByText(/Nothing in it changes, and alice can share it with you again/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Leave" }));

  expect(mocks.leave.mutate).toHaveBeenCalledWith(TRIP.id, expect.anything());
  expect(mocks.success).toHaveBeenCalledWith("Left Trip.");
  expect(onClose).toHaveBeenCalled();
});

it("reports a refused leave", () => {
  mocks.leave.mutate.mockImplementation((_id, options) =>
    options.onError(new ApiClientError("not_found", "share not found", 404)),
  );
  render(<LeaveSharedFolderDialog grant={TRIP} onClose={vi.fn()} />);

  fireEvent.click(screen.getByRole("button", { name: "Leave" }));

  expect(mocks.error).toHaveBeenCalledWith("Share not found.");
});

it("stays when cancelled", () => {
  const onClose = vi.fn();
  render(<LeaveSharedFolderDialog grant={TRIP} onClose={onClose} />);

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(onClose).toHaveBeenCalled();
  expect(mocks.leave.mutate).not.toHaveBeenCalled();
});
