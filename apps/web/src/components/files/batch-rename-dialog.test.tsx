// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BatchRenameDialog } from "./batch-rename-dialog";

function file(name: string): FsEntry {
  return {
    path: `/trip/${name}`,
    name,
    kind: "file",
    size: 0,
    ext: "",
    mime: null,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

const entries = [file("IMG_2.jpg"), file("IMG_1.png")];
const siblings = [...entries, file("beach.jpg")];

afterEach(cleanup);

function previewNames(): string[] {
  return within(screen.getByRole("list", { name: "Preview" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

it("previews replaced text and blocks a name already in the folder", async () => {
  render(
    <BatchRenameDialog
      entries={entries}
      siblings={siblings}
      onClose={vi.fn()}
      onRename={vi.fn()}
    />,
  );
  await screen.findByRole("dialog");
  const rename = screen.getByRole("button", { name: "Rename" });
  expect(rename.hasAttribute("disabled")).toBe(true);

  fireEvent.change(screen.getByLabelText("Find"), { target: { value: "IMG_" } });
  fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "beach" } });
  expect(previewNames()).toEqual(["IMG_2.jpgbeach2.jpg", "IMG_1.pngbeach1.png"]);
  expect(rename.hasAttribute("disabled")).toBe(false);

  fireEvent.change(screen.getByLabelText("Find"), { target: { value: "IMG_2" } });
  expect(previewNames()[0]).toBe("IMG_2.jpgbeach.jpg");
  expect(screen.getByText("Some new names are already taken.")).toBeTruthy();
  expect(rename.hasAttribute("disabled")).toBe(true);
});

it("numbers in listing order and renames one by one", async () => {
  const onRename = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <BatchRenameDialog
      entries={entries}
      siblings={siblings}
      onClose={onClose}
      onRename={onRename}
    />,
  );
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("tab", { name: "Number" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Trip" } });
  expect(previewNames()).toEqual(["IMG_2.jpgTrip 1.jpg", "IMG_1.pngTrip 2.png"]);

  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(onRename.mock.calls).toEqual([
    [{ path: "/trip/IMG_2.jpg", newName: "Trip 1.jpg" }],
    [{ path: "/trip/IMG_1.png", newName: "Trip 2.png" }],
  ]);
});

it("stops at the first failed rename", async () => {
  const onRename = vi.fn().mockRejectedValue(new Error("taken"));
  const onClose = vi.fn();
  render(
    <BatchRenameDialog
      entries={entries}
      siblings={siblings}
      onClose={onClose}
      onRename={onRename}
    />,
  );
  await screen.findByRole("dialog");
  fireEvent.change(screen.getByLabelText("Find"), { target: { value: "IMG" } });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(onRename).toHaveBeenCalledTimes(1);
});
