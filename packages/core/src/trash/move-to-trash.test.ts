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

    const trash = createRecycleFolderTrash({ storage: wrapped, trashPath: "/.trash" });
    const listing = await trash.list();
    expect(listing.entries.map((entry) => entry.originalPath)).toEqual(["/docs/a.txt"]);
    await trash.restore(idFor(FILE_LEAF));
    expect(storage.dump()).toEqual({ "/docs/a.txt": "hello" });
  });

  it("round-trips numeric, Unicode, percent, and maximum-length path segments", async () => {
    const originalPath = `/2026/Å %20/${"x".repeat(255)}`;
    const storage = createMemoryStorage({ [originalPath]: "hello" });
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });
    const trash = createRecycleFolderTrash({ storage: wrapped, trashPath: "/.trash" });

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

    const trash = createRecycleFolderTrash({ storage: wrapped, trashPath: "/.trash" });
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
    const trash = createRecycleFolderTrash({ storage: wrapped, trashPath: "/.trash" });
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

  it("asks storage to refuse a taken leaf rather than replace it", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "hello" });
    const moves: unknown[] = [];
    const originalMove = storage.move.bind(storage);
    storage.move = async (path, target, opts) => {
      moves.push(opts);
      return originalMove(path, target, opts);
    };
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });

    await wrapped.deleteFile("/docs/a.txt");

    expect(moves).toEqual([{ overwrite: false }]);
  });

  it("does not recycle a directory containing the configured trash folder", async () => {
    const storage = createMemoryStorage({ "/docs/.trash/old.txt/123": "keep" });
    const wrapped = withMoveToTrash({ storage, trashPath: "/docs/.trash", clock: () => AT });

    await expect(wrapped.deleteDir("/docs")).rejects.toMatchObject({ kind: "bad_request" });
    expect(storage.dump()).toEqual({ "/docs/.trash/old.txt/123": "keep" });
  });

  it("reports the leaf it chose, and only after the move succeeded", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "hello", "/docs/2026/b.txt": "there" });
    const recycled: [string, string][] = [];
    const wrapped = withMoveToTrash({
      storage,
      trashPath: "/.trash",
      clock: () => AT,
      onRecycled: (path, leaf) => recycled.push([path, leaf]),
    });

    await wrapped.deleteFile("/docs/a.txt");
    await wrapped.deleteDir("/docs/2026");
    await expect(wrapped.deleteFile("/docs/missing.txt")).rejects.toThrow();
    await wrapped.deleteFile(FILE_LEAF);

    expect(recycled).toEqual([
      ["/docs/a.txt", FILE_LEAF],
      ["/docs/2026", DIR_LEAF],
    ]);
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
