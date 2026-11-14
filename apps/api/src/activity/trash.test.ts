import { parseMoveTrashLeaf, type StorageProvider, withMoveToTrash } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { describe, expect, it, vi } from "vitest";
import { captureRecycleReceipt, deleteWithActivityReceipt } from "./trash.js";

const TRASH = "/.trash";
const CLOCK = new Date("2026-09-19T10:00:00.000Z");

async function seed(storage: StorageProvider, path: string): Promise<void> {
  await storage.upload(path, new TextEncoder().encode("bytes"), { mkdirParents: true });
}

describe("trash binding for a recorded delete", () => {
  it("uses the leaf fdrive moved the item to", async () => {
    const base = createMemoryStorage();
    await seed(base, "/docs/a.txt");
    const storage = withMoveToTrash({
      storage: base,
      trashPath: TRASH,
      clock: () => CLOCK,
      onRecycled: captureRecycleReceipt,
    });

    const facts = await deleteWithActivityReceipt(storage, "/docs/a.txt", "file");

    expect(facts).toEqual({
      path: "/docs/a.txt",
      kind: "file",
      trashLeaf: expect.any(String),
    });
    expect(parseMoveTrashLeaf(TRASH, facts.trashLeaf as string)).toMatchObject({
      originalPath: "/docs/a.txt",
      kind: "file",
    });
  });

  it("tells a delete wrapping another, of the same path, where it went too", async () => {
    const base = createMemoryStorage();
    await seed(base, "/docs/a.txt");
    const moving = withMoveToTrash({
      storage: base,
      trashPath: TRASH,
      clock: () => CLOCK,
      onRecycled: captureRecycleReceipt,
    });
    // As the activity-recording storage MCP uses wraps the move-to-trash one.
    const recording: StorageProvider = {
      ...moving,
      deleteFile: async (path) => {
        await deleteWithActivityReceipt(moving, path, "file");
      },
    };

    const facts = await deleteWithActivityReceipt(recording, "/docs/a.txt", "file");

    expect(parseMoveTrashLeaf(TRASH, facts.trashLeaf as string)?.originalPath).toBe("/docs/a.txt");
  });

  it("deletes a folder for real and never lists anything when there is no Trash", async () => {
    const storage = createMemoryStorage();
    await storage.mkdir("/docs");
    const list = vi.spyOn(storage, "list");

    expect(await deleteWithActivityReceipt(storage, "/docs", "dir")).toEqual({
      path: "/docs",
      kind: "dir",
    });
    expect(list).not.toHaveBeenCalled();
    expect(storage.dirs()).not.toContain("/docs");
  });

  it("ignores a receipt reported for a different path", async () => {
    const base = createMemoryStorage();
    await seed(base, "/docs/a.txt");
    const storage: StorageProvider = {
      ...base,
      async deleteFile(path) {
        captureRecycleReceipt("/somewhere/else", `${TRASH}/elsewhere/1`);
        await base.deleteFile(path);
      },
    };

    expect(await deleteWithActivityReceipt(storage, "/docs/a.txt", "file")).toEqual({
      path: "/docs/a.txt",
      kind: "file",
    });
  });
});
