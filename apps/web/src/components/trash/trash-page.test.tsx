// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TrashPage } from "./trash-page";

const fixtures = vi.hoisted(() => ({
  restore: vi.fn(),
  restorePending: false,
  restoreConflict: false,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: fixtures.toastSuccess, error: fixtures.toastError },
}));
vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/components/files/destination-picker", () => ({
  DestinationPicker: (props: {
    open: boolean;
    pending?: boolean;
    onConfirm: (folder: string) => void;
  }) =>
    props.open ? (
      <div role="dialog" aria-label="Restore to">
        <button
          type="button"
          disabled={props.pending}
          onClick={() => props.onConfirm("/elsewhere")}
        >
          {props.pending ? "Restoring…" : "Restore here"}
        </button>
      </div>
    ) : null,
}));
vi.mock("@/components/files/empty-state", () => ({ EmptyState: () => null }));
vi.mock("@/components/files/error-state", () => ({ ErrorState: () => null }));
vi.mock("@/lib/trash/queries", () => ({
  isRestoreConflict: () => fixtures.restoreConflict,
  useTrashStatus: () => ({ data: { retentionHours: null } }),
  useTrash: () => ({
    data: {
      entries: [
        {
          id: "trash-1",
          name: "report.txt",
          originalPath: "/docs/report.txt",
          size: 12,
          deletedAt: "2026-01-01T00:00:00Z",
        },
      ],
      truncated: false,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useTrashRestore: () => ({ mutate: fixtures.restore, isPending: fixtures.restorePending }),
  useTrashPurge: () => ({ mutate: vi.fn(), isPending: false }),
  useTrashEmpty: () => ({ mutate: vi.fn(), isPending: false }),
}));

type RestoreCallbacks = {
  onSuccess: () => void;
  onError: (error: Error) => void;
  onSettled?: () => void;
};

function lastRestoreCallbacks(): RestoreCallbacks {
  const callbacks = fixtures.restore.mock.lastCall?.[1] as RestoreCallbacks | undefined;
  if (callbacks === undefined) {
    throw new Error("restore was not called");
  }
  return callbacks;
}

beforeEach(() => {
  fixtures.restorePending = false;
  fixtures.restoreConflict = false;
});

afterEach(() => {
  cleanup();
  fixtures.restore.mockClear();
  fixtures.toastSuccess.mockClear();
  fixtures.toastError.mockClear();
  window.localStorage.clear();
});

function selectReport() {
  fireEvent.click(screen.getByRole("checkbox", { name: "Select report.txt" }));
}

it("uses the global grid default and restores the selected trash item", () => {
  window.localStorage.setItem("fdrive.view", JSON.stringify("grid"));
  render(<TrashPage />);

  expect(document.querySelector('[data-slot="trash-grid"]')).not.toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(screen.getByText("1 selected")).toBeDefined();
  selectReport();
  selectReport();
  const restore = screen.getByRole("button", { name: "Restore" });
  expect(restore).not.toHaveProperty("disabled", true);
  expect(restore.getAttribute("aria-busy")).not.toBe("true");
  fireEvent.click(restore);
  expect(fixtures.restore).toHaveBeenCalledWith(
    { ids: ["trash-1"] },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

it("shows a busy indicator on Restore while a toolbar restore is in flight", () => {
  const view = render(<TrashPage />);
  selectReport();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  fixtures.restorePending = true;
  view.rerender(<TrashPage />);

  const busy = screen.getByRole("button", { name: "Restoring…" });
  expect(busy.hasAttribute("disabled")).toBe(true);
  expect(busy.getAttribute("aria-busy")).toBe("true");
  expect(busy.querySelector("svg.animate-spin")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  expect(screen.getByRole("button", { name: "Restore to" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(busy);
  expect(fixtures.restore).toHaveBeenCalledTimes(1);

  fixtures.restorePending = false;
  view.rerender(<TrashPage />);
  expect(screen.getByRole("button", { name: "Restore" }).getAttribute("aria-busy")).not.toBe(
    "true",
  );
});

it("keeps the Restore to picker open, busy, until the restore succeeds", () => {
  const view = render(<TrashPage />);
  selectReport();
  fireEvent.click(screen.getByRole("button", { name: "Restore to" }));
  const dialog = screen.getByRole("dialog", { name: "Restore to" });
  fireEvent.click(screen.getByRole("button", { name: "Restore here" }));
  expect(fixtures.restore).toHaveBeenCalledWith(
    { ids: ["trash-1"], target: "/elsewhere/report.txt" },
    expect.objectContaining({ onSettled: expect.any(Function) }),
  );

  fixtures.restorePending = true;
  view.rerender(<TrashPage />);
  expect(screen.getByRole("dialog", { name: "Restore to" })).toBe(dialog);
  expect(screen.getByRole("button", { name: "Restoring…" }).hasAttribute("disabled")).toBe(true);
  // The toolbar is disabled but does not claim the busy state for itself.
  const toolbarRestore = screen.getByRole("button", { name: "Restore" });
  expect(toolbarRestore.hasAttribute("disabled")).toBe(true);
  expect(toolbarRestore.getAttribute("aria-busy")).not.toBe("true");

  const callbacks = lastRestoreCallbacks();
  fixtures.restorePending = false;
  callbacks.onSuccess();
  callbacks.onSettled?.();
  view.rerender(<TrashPage />);
  expect(screen.queryByRole("dialog", { name: "Restore to" })).toBeNull();
  expect(fixtures.toastSuccess).toHaveBeenCalledWith("Restored 1 item.");
});

it("closes the Restore to picker on a conflict and offers it again from the toast", () => {
  fixtures.restoreConflict = true;
  const view = render(<TrashPage />);
  selectReport();
  fireEvent.click(screen.getByRole("button", { name: "Restore to" }));
  fireEvent.click(screen.getByRole("button", { name: "Restore here" }));

  const callbacks = lastRestoreCallbacks();
  callbacks.onError(new Error("conflict"));
  callbacks.onSettled?.();
  view.rerender(<TrashPage />);
  expect(screen.queryByRole("dialog", { name: "Restore to" })).toBeNull();
  expect(fixtures.toastError).toHaveBeenCalledWith(
    'Could not restore "report.txt": a file already exists at that location.',
    expect.objectContaining({ action: expect.objectContaining({ label: "Restore to" }) }),
  );

  const action = fixtures.toastError.mock.lastCall?.[1].action as { onClick: () => void };
  action.onClick();
  view.rerender(<TrashPage />);
  expect(screen.getByRole("dialog", { name: "Restore to" })).toBeDefined();
});
