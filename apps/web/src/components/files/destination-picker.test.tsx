// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DestinationPicker, type DestinationPickerMode } from "./destination-picker";

const fs = vi.hoisted(() => ({
  listing: vi.fn(),
  mutate: vi.fn(),
  pending: false,
}));
vi.mock("@/lib/files/queries", () => ({
  useListing: (path: string) => fs.listing(path),
  useMkdir: () => ({ mutate: fs.mutate, isPending: fs.pending }),
}));

function folder(path: string): FsEntry {
  return {
    path,
    name: path.split("/").at(-1) ?? "",
    kind: "dir",
    size: 0,
    ext: "",
    mime: null,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  fs.pending = false;
  fs.mutate.mockReset();
  fs.listing.mockReset().mockImplementation((path: string) => ({
    data: { entries: path === "/" ? [folder("/photos"), folder("/source")] : [] },
    isLoading: false,
  }));
});
afterEach(cleanup);

async function openNewFolder() {
  fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
  return screen.findByRole("dialog", { name: "New folder" });
}

it.each<[DestinationPickerMode, string]>([
  ["move", "Move here"],
  ["copy", "Copy here"],
  ["compressDestination", "Choose"],
  ["extractTo", "Extract here"],
  ["restoreTo", "Restore here"],
])("creates a folder and waits for explicit confirmation in %s", async (mode, label) => {
  const onConfirm = vi.fn();
  render(<DestinationPicker open mode={mode} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
  const dialog = await openNewFolder();
  fireEvent.change(within(dialog).getByLabelText("Folder name"), {
    target: { value: "  Holiday  " },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  expect(fs.mutate).toHaveBeenCalledWith("/Holiday", expect.any(Object));
  act(() => fs.mutate.mock.calls[0]?.[1].onSuccess(folder("/Holiday")));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull());
  expect(fs.listing).toHaveBeenLastCalledWith("/Holiday");
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: label }));
  expect(onConfirm).toHaveBeenCalledWith("/Holiday");
});

it("creates inside the browsed directory and preserves it when creation is cancelled", async () => {
  render(<DestinationPicker open mode="copy" onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "photos" }));
  let dialog = await openNewFolder();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull());
  expect(fs.mutate).not.toHaveBeenCalled();
  expect(fs.listing).toHaveBeenLastCalledWith("/photos");
  dialog = await openNewFolder();
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  expect(fs.mutate).toHaveBeenCalledWith("/photos/Untitled folder", expect.any(Object));
});

it("allows a new sibling even when the current directory cannot be confirmed", async () => {
  render(
    <DestinationPicker
      open
      mode="move"
      sourcePaths={["/source"]}
      onOpenChange={vi.fn()}
      onConfirm={vi.fn()}
    />,
  );
  expect((await screen.findByRole("button", { name: "Move here" })).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.queryByRole("button", { name: "source" })).toBeNull();
  expect(screen.getByRole("button", { name: "New folder" }).hasAttribute("disabled")).toBe(false);
});

it("blocks creation inside a source subtree", async () => {
  render(
    <DestinationPicker
      open
      mode="move"
      initialPath="/source/nested"
      sourcePaths={["/source"]}
      onOpenChange={vi.fn()}
      onConfirm={vi.fn()}
    />,
  );
  expect((await screen.findByRole("button", { name: "New folder" })).hasAttribute("disabled")).toBe(
    true,
  );
});

it("blocks navigation and dismissal while creating, then preserves the name for retry", async () => {
  const props = { open: true, mode: "copy" as const, onOpenChange: vi.fn(), onConfirm: vi.fn() };
  const view = render(<DestinationPicker {...props} />);
  const dialog = await openNewFolder();
  fireEvent.change(within(dialog).getByLabelText("Folder name"), { target: { value: "Retry me" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  fs.pending = true;
  view.rerender(<DestinationPicker {...props} />);
  const creating = within(dialog).getByRole("button", { name: "Creating…" });
  expect(creating.hasAttribute("disabled")).toBe(true);
  expect(creating.getAttribute("aria-busy")).toBe("true");
  fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(fs.mutate).toHaveBeenCalledTimes(1);
  expect(props.onOpenChange).not.toHaveBeenCalled();
  expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(
    screen.getByRole("button", { name: "photos", hidden: true }).hasAttribute("disabled"),
  ).toBe(true);
  fs.pending = false;
  view.rerender(<DestinationPicker {...props} />);
  expect((within(dialog).getByLabelText("Folder name") as HTMLInputElement).value).toBe("Retry me");
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  expect(fs.mutate).toHaveBeenCalledTimes(2);
});

it("starts a fresh session when a mounted caller closes and reopens", async () => {
  const props = { mode: "extractTo" as const, onOpenChange: vi.fn(), onConfirm: vi.fn() };
  const view = render(<DestinationPicker {...props} open />);
  fireEvent.click(await screen.findByRole("button", { name: "photos" }));
  await openNewFolder();
  view.rerender(<DestinationPicker {...props} open={false} />);
  view.rerender(<DestinationPicker {...props} open initialPath="/another" />);
  await screen.findByRole("dialog", { name: "Extract to" });
  expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull();
  expect(fs.listing).toHaveBeenLastCalledWith("/another");
});

it.each([" ", ".", "..", "../escape", "nested/folder", "a".repeat(256)])(
  "rejects unsafe folder name %s",
  async (name) => {
    render(<DestinationPicker open mode="copy" onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    const dialog = await openNewFolder();
    fireEvent.change(within(dialog).getByLabelText("Folder name"), { target: { value: name } });
    expect(within(dialog).getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    expect(fs.mutate).not.toHaveBeenCalled();
  },
);
