// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TrashPage } from "./trash-page";

const fixtures = vi.hoisted(() => ({ restore: vi.fn() }));

vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/components/files/destination-picker", () => ({ DestinationPicker: () => null }));
vi.mock("@/components/files/empty-state", () => ({ EmptyState: () => null }));
vi.mock("@/components/files/error-state", () => ({ ErrorState: () => null }));
vi.mock("@/lib/trash/queries", () => ({
  isRestoreConflict: () => false,
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
  useTrashRestore: () => ({ mutate: fixtures.restore, isPending: false }),
  useTrashPurge: () => ({ mutate: vi.fn(), isPending: false }),
  useTrashEmpty: () => ({ mutate: vi.fn(), isPending: false }),
}));

afterEach(() => {
  cleanup();
  fixtures.restore.mockClear();
  window.localStorage.clear();
});

it("uses the global grid default and restores the selected trash item", () => {
  window.localStorage.setItem("fdrive.view", JSON.stringify("grid"));
  render(<TrashPage />);

  expect(document.querySelector('[data-slot="trash-grid"]')).not.toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(screen.getByText("1 selected")).toBeDefined();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select report.txt" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select report.txt" }));
  const restore = screen.getByRole("button", { name: "Restore" });
  expect(restore).not.toHaveProperty("disabled", true);
  fireEvent.click(restore);
  expect(fixtures.restore).toHaveBeenCalledWith(
    { ids: ["trash-1"] },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});
