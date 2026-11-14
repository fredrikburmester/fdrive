import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.success, dismiss: mocks.dismiss } }));

import { latestTrashIds, offerUndo, undoLatest } from "./undo";

/** Clicks the Undo action of the `index`th success toast shown. */
function clickUndo(index: number): void {
  const options = mocks.success.mock.calls[index]?.[1] as { action: { onClick: () => void } };
  options.action.onClick();
}

describe("undo", () => {
  beforeEach(async () => {
    await undoLatest();
    vi.clearAllMocks();
    mocks.success.mockImplementation(() => mocks.success.mock.calls.length);
  });

  it("offers Undo in a success toast and lets the shortcut reverse it once", async () => {
    const undo = vi.fn(() => Promise.resolve());
    offerUndo("Moved 2 items", undo);

    expect(mocks.success).toHaveBeenCalledWith("Moved 2 items", {
      action: { label: "Undo", onClick: expect.any(Function) },
    });
    await undoLatest();
    await undoLatest();

    expect(undo).toHaveBeenCalledTimes(1);
    expect(mocks.dismiss).toHaveBeenCalledWith(1);
  });

  it("reverses only the latest action, while an older toast still undoes its own", async () => {
    const older = vi.fn(() => Promise.resolve());
    const newer = vi.fn(() => Promise.resolve());
    offerUndo('Renamed to "b.txt"', older);
    offerUndo("Moved 1 item", newer);

    await undoLatest();
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();

    clickUndo(0);
    await vi.waitFor(() => expect(older).toHaveBeenCalledTimes(1));
  });

  it("does nothing when the toast's Undo comes after the shortcut already undid it", async () => {
    const undo = vi.fn(() => Promise.resolve());
    offerUndo("Moved 1 item", undo);

    await undoLatest();
    clickUndo(0);

    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed undo from rejecting, since it reports its own failure", async () => {
    offerUndo("Moved 1 item", () => Promise.reject(new Error("conflict")));

    await expect(undoLatest()).resolves.toBeUndefined();
  });
});

describe("latestTrashIds", () => {
  const entry = (id: string, originalPath: string) => ({
    id,
    originalPath,
    name: originalPath.slice(1),
    size: 1,
    deletedAt: "2026-11-14T10:00:00.000Z",
  });

  it("takes the newest entry for each path and skips paths it cannot find", () => {
    const entries = [entry("new-a", "/a.txt"), entry("b", "/b"), entry("old-a", "/a.txt")];

    expect(latestTrashIds(entries, ["/a.txt", "/missing", "/b"])).toEqual(["new-a", "b"]);
  });
});
