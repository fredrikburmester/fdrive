import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../testing/memory-storage.ts";
import { withMoveToTrash } from "./move-to-trash.ts";
import { moveTrashLeafPath } from "./recycle-folder.ts";
import { createRecycleFolderTrash } from "./recycle-folder-trash.ts";

const AT = new Date("2026-09-10T12:00:00.000Z");
const LEAF = (BigInt(AT.getTime()) * BigInt(1_000_000)).toString();
const FILE_LEAF = moveTrashLeafPath("/.trash", "/docs/a.txt", "file", LEAF);
const DIR_LEAF = moveTrashLeafPath("/.trash", "/docs/2026", "dir", LEAF);
const idFor = (path: string) => path.slice("/.trash/".length);

describe("withMoveToTrash", () => {
  it("moves a deleted file into the recycle folder layout the trash lists back", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "hello" });
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });
    await wrapped.deleteFile("/docs/a.txt");
    expect(storage.dump()).toEqual({ [FILE_LEAF]: "hello" });

    const trash = createRecycleFolderTrash({
      storage: wrapped,
      trashPath: "/.trash",
      layout: "move",
    });
    const listing = await trash.list();
    expect(listing.entries.map((entry) => entry.originalPath)).toEqual(["/docs/a.txt"]);
    await trash.restore(idFor(FILE_LEAF));
    expect(storage.dump()).toEqual({ "/docs/a.txt": "hello" });
  });

  it("round-trips numeric, Unicode, percent, and maximum-length path segments", async () => {
    const originalPath = `/2026/Å %20/${"x".repeat(255)}`;
    const storage = createMemoryStorage({ [originalPath]: "hello" });
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });
    const trash = createRecycleFolderTrash({
      storage: wrapped,
      trashPath: "/.trash",
      layout: "move",
    });

    await wrapped.deleteFile(originalPath);
    const [entry] = (await trash.list()).entries;
    expect(entry?.originalPath).toBe(originalPath);

    await trash.restore(entry?.id ?? "missing");
    expect(storage.dump()).toEqual({ [originalPath]: "hello" });
  });

  it("moves a deleted directory with its contents and a root-level file", async () => {
    const storage = createMemoryStorage({ "/docs/2026/b.txt": "b", "/top.txt": "t" });
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });
    await wrapped.deleteDir("/docs/2026");
    await wrapped.deleteFile("/top.txt");
    const topLeaf = moveTrashLeafPath("/.trash", "/top.txt", "file", LEAF);
    expect(storage.dump()).toEqual({
      [`${DIR_LEAF}/b.txt`]: "b",
      [topLeaf]: "t",
    });

    const trash = createRecycleFolderTrash({
      storage: wrapped,
      trashPath: "/.trash",
      layout: "move",
    });
    expect((await trash.list()).entries.map((entry) => entry.originalPath).sort()).toEqual([
      "/docs/2026",
      "/top.txt",
    ]);

    const restored = await trash.restore(idFor(DIR_LEAF));
    expect(restored).toMatchObject({ path: "/docs/2026", kind: "dir" });
    expect(storage.dump()).toEqual({
      "/docs/2026/b.txt": "b",
      [topLeaf]: "t",
    });
  });

  it("round-trips an empty directory", async () => {
    const storage = createMemoryStorage();
    await storage.mkdir("/empty");
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });

    await wrapped.deleteDir("/empty");
    const trash = createRecycleFolderTrash({
      storage: wrapped,
      trashPath: "/.trash",
      layout: "move",
    });
    expect((await trash.list()).entries.map((entry) => entry.originalPath)).toEqual(["/empty"]);

    const emptyLeaf = moveTrashLeafPath("/.trash", "/empty", "dir", LEAF);
    await trash.restore(idFor(emptyLeaf));
    expect(storage.dirs()).toContain("/empty");
  });

  it("keeps the directory when the move fails", async () => {
    const storage = createMemoryStorage({ "/docs/keep.txt": "keep" });
    storage.move = async () => {
      throw new Error("move failed");
    };
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });

    await expect(wrapped.deleteDir("/docs")).rejects.toThrow("move failed");
    expect(storage.dump()).toEqual({ "/docs/keep.txt": "keep" });
  });

  it("keeps the directory when its leaf path is occupied", async () => {
    const storage = createMemoryStorage({
      "/docs/2026/keep.txt": "keep",
      [`${DIR_LEAF}/older.txt`]: "older trash item",
    });
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });

    await expect(wrapped.deleteDir("/docs/2026")).rejects.toMatchObject({ kind: "conflict" });
    expect(storage.dump()).toMatchObject({ "/docs/2026/keep.txt": "keep" });
  });

  it("propagates a leaf preflight failure without moving the source", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "keep" });
    const originalStat = storage.stat.bind(storage);
    storage.stat = async (path: string) => {
      if (path === FILE_LEAF) {
        throw new Error("stat failed");
      }
      return originalStat(path);
    };
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });

    await expect(wrapped.deleteFile("/docs/a.txt")).rejects.toThrow("stat failed");
    expect(storage.dump()).toEqual({ "/docs/a.txt": "keep" });
  });

  it("does not recycle a directory containing the configured trash folder", async () => {
    const storage = createMemoryStorage({ "/docs/.trash/old.txt/123": "keep" });
    const wrapped = withMoveToTrash({ storage, trashPath: "/docs/.trash", clock: () => AT });

    await expect(wrapped.deleteDir("/docs")).rejects.toMatchObject({ kind: "bad_request" });
    expect(storage.dump()).toEqual({ "/docs/.trash/old.txt/123": "keep" });
  });

  it("deletes for real inside the recycle folder so purge and empty work", async () => {
    const storage = createMemoryStorage({ [`/.trash/docs/a.txt/${LEAF}`]: "hello" });
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });
    await wrapped.deleteFile(`/.trash/docs/a.txt/${LEAF}`);
    await wrapped.deleteDir("/.trash/docs");
    expect(storage.dump()).toEqual({});
    expect(storage.dirs()).not.toContain("/.trash/docs");
    await wrapped.deleteDir("/.trash");
    expect(storage.dirs()).not.toContain("/.trash");
  });
});
