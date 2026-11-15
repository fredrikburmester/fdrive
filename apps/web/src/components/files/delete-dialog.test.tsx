// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/trash-settings-queries", () => ({ useTrashSettings: () => settings() }));
const { DeleteDialog } = await import("./delete-dialog");

const folder: FsEntry = {
  path: "/photos",
  name: "photos",
  kind: "dir",
  size: 0,
  ext: "",
  mime: null,
  modifiedAt: "2026-01-01T00:00:00.000Z",
};
beforeEach(() => settings.mockReturnValue({ data: { retentionDays: 30 } }));
afterEach(cleanup);

it("confirms with the resting label and lets the user cancel while idle", async () => {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  render(<DeleteDialog entries={[folder]} onOpenChange={onOpenChange} onConfirm={onConfirm} />);
  const dialog = await screen.findByRole("alertdialog");
  const confirm = screen.getByRole("button", { name: "Move to Trash" });
  expect(confirm.getAttribute("aria-busy")).not.toBe("true");
  fireEvent.click(confirm);
  expect(onConfirm).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("shows a busy indicator and blocks dismissal while the request is pending", async () => {
  const onOpenChange = vi.fn();
  render(
    <DeleteDialog entries={[folder]} onOpenChange={onOpenChange} onConfirm={vi.fn()} pending />,
  );
  const dialog = await screen.findByRole("alertdialog");
  const confirm = screen.getByRole("button", { name: "Moving to Trash…" });
  expect(confirm.getAttribute("aria-busy")).toBe("true");
  expect(confirm.hasAttribute("disabled")).toBe(true);
  expect(confirm.querySelector("svg.animate-spin")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Move to Trash" })).toBeNull();

  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(cancel.hasAttribute("disabled")).toBe(true);
  fireEvent.click(cancel);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("says when Trash deletes the items, once that setting has loaded", async () => {
  const { unmount } = render(
    <DeleteDialog entries={[folder]} onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
  );
  expect((await screen.findByRole("alertdialog")).textContent).toContain(
    '"photos" will be moved to Trash. Items in Trash are deleted permanently after 30 days.',
  );
  unmount();

  settings.mockReturnValue({ data: undefined });
  render(<DeleteDialog entries={[folder]} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain('"photos" will be moved to Trash.');
  expect(dialog.textContent).not.toContain("deleted permanently");
});

it("says an item in a folder shared with the login goes to its owner's Trash", async () => {
  const shared: FsEntry = { ...folder, path: "/Shared with me/Team/photos" };
  render(
    <DeleteDialog
      entries={[shared]}
      onOpenChange={vi.fn()}
      onConfirm={vi.fn()}
      received={[
        {
          id: "00000000-0000-4000-8000-000000000001",
          owner: "alice",
          name: "Team",
          path: "/Shared with me/Team",
          access: "write",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]}
    />,
  );
  expect((await screen.findByRole("alertdialog")).textContent).toContain(
    '"photos" will be moved to alice\'s Trash.',
  );
});
