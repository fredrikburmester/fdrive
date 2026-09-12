// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeleteDialog } from "./delete-dialog";

const folder: FsEntry = {
  path: "/photos",
  name: "photos",
  kind: "dir",
  size: 0,
  ext: "",
  mime: null,
  modifiedAt: "2026-01-01T00:00:00.000Z",
};
const trash = { available: true, retentionHours: null };

afterEach(cleanup);

it("confirms with the resting label and lets the user cancel while idle", async () => {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  render(
    <DeleteDialog
      entries={[folder]}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      trash={trash}
    />,
  );
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
    <DeleteDialog
      entries={[folder]}
      onOpenChange={onOpenChange}
      onConfirm={vi.fn()}
      pending
      trash={trash}
    />,
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

it("uses the permanent-delete progressive label without a trash", async () => {
  render(<DeleteDialog entries={[folder]} onOpenChange={vi.fn()} onConfirm={vi.fn()} pending />);
  await screen.findByRole("alertdialog");
  expect(screen.getByRole("button", { name: "Deleting…" })).toBeTruthy();
});
