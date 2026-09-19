import { StorageError, type StorageProvider, withMoveToTrash } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { describe, expect, it, vi } from "vitest";
import { activityTrashLeaf, captureRecycleReceipt, deleteWithActivityReceipt } from "./trash.js";

const TRASH = "/.trash";
const CLOCK = new Date("2026-09-19T10:00:00.000Z");

/**
 * A provider whose own rule renames deletions into the recycle folder and
 * tells fdrive nothing about where they landed, the way SFTPGo behaves.
 */
function withProviderRule(leavesPerDelete: number): StorageProvider {
  const base = createMemoryStorage();
  let tick = 0;
  return {
    ...base,
    async deleteFile(path) {
      for (let index = 0; index < leavesPerDelete; index += 1) {
        tick += 1;
        const leaf = `${TRASH}${path}/${BigInt(CLOCK.getTime() + tick) * BigInt(1_000_000)}`;
        await base.mkdir(`${TRASH}${path}`, { parents: true });
        await base.upload(leaf, new TextEncoder().encode("moved"));
      }
      await base.deleteFile(path);
    },
  };
}

async function seed(storage: StorageProvider, path: string): Promise<void> {
  await storage.upload(path, new TextEncoder().encode("bytes"), { mkdirParents: true });
}

describe("trash binding for a recorded delete", () => {
  it("uses the leaf fdrive moved the item to itself", async () => {
    const base = createMemoryStorage();
    await seed(base, "/docs/a.txt");
    const storage = withMoveToTrash({
      storage: base,
      trashPath: TRASH,
      clock: () => CLOCK,
      onRecycled: captureRecycleReceipt,
    });

    const facts = await deleteWithActivityReceipt(storage, "/docs/a.txt", "file", TRASH);

    expect(facts).toMatchObject({ path: "/docs/a.txt", trashStrategy: "fdrive_move" });
    expect(activityTrashLeaf(TRASH, facts.trashLeaf as string)).toMatchObject({
      originalPath: "/docs/a.txt",
      kind: "file",
    });
  });

  it("accepts a single new provider-generated leaf as the binding", async () => {
    const storage = withProviderRule(1);
    await seed(storage, "/docs/a.txt");

    const facts = await deleteWithActivityReceipt(storage, "/docs/a.txt", "file", TRASH);

    expect(facts).toMatchObject({ trashStrategy: "sftpgo_rule" });
    expect(activityTrashLeaf(TRASH, facts.trashLeaf as string)?.originalPath).toBe("/docs/a.txt");
  });

  it("leaves the binding unresolved rather than guessing between concurrent leaves", async () => {
    const storage = withProviderRule(2);
    await seed(storage, "/docs/a.txt");

    const facts = await deleteWithActivityReceipt(storage, "/docs/a.txt", "file", TRASH);

    expect(facts).toEqual({ path: "/docs/a.txt", kind: "file" });
  });

  it("leaves the binding unresolved when the trash branch cannot be read", async () => {
    const storage = withProviderRule(1);
    await seed(storage, "/docs/a.txt");
    vi.spyOn(storage, "list").mockRejectedValue(new StorageError("forbidden", "denied"));

    expect(await deleteWithActivityReceipt(storage, "/docs/a.txt", "file", TRASH)).toEqual({
      path: "/docs/a.txt",
      kind: "file",
    });
  });

  it("leaves the binding unresolved when the branch holds more leaves than it inspects", async () => {
    const storage = withProviderRule(1);
    await seed(storage, "/docs/a.txt");
    vi.spyOn(storage, "list").mockResolvedValue(
      Array.from({ length: 1001 }, (_, index) => ({
        name: String(index),
        path: `${TRASH}/docs/a.txt/${index}`,
        kind: "file" as const,
        size: 0,
        modifiedAt: CLOCK,
        ext: "",
        mime: null,
      })),
    );

    expect(await deleteWithActivityReceipt(storage, "/docs/a.txt", "file", TRASH)).toEqual({
      path: "/docs/a.txt",
      kind: "file",
    });
  });

  it("leaves the binding unresolved when the branch is unreadable only afterwards", async () => {
    const storage = withProviderRule(1);
    await seed(storage, "/docs/a.txt");
    const list = storage.list.bind(storage);
    vi.spyOn(storage, "list").mockImplementationOnce(list).mockRejectedValueOnce(new Error("gone"));

    expect(await deleteWithActivityReceipt(storage, "/docs/a.txt", "file", TRASH)).toEqual({
      path: "/docs/a.txt",
      kind: "file",
    });
  });

  it("deletes a folder for real and never lists trash when there is none", async () => {
    const storage = createMemoryStorage();
    await storage.mkdir("/docs");
    const list = vi.spyOn(storage, "list");

    expect(await deleteWithActivityReceipt(storage, "/docs", "dir", null)).toEqual({
      path: "/docs",
      kind: "dir",
    });
    expect(list).not.toHaveBeenCalled();
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

    expect(await deleteWithActivityReceipt(storage, "/docs/a.txt", "file", TRASH)).toEqual({
      path: "/docs/a.txt",
      kind: "file",
    });
  });
});
