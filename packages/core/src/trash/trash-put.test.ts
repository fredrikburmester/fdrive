import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../testing/memory-storage.ts";
import { moveTrashLeafPath } from "./recycle-folder.ts";

const AT = new Date("2026-09-10T12:00:00.000Z");
const LEAF = (BigInt(AT.getTime()) * BigInt(1_000_000)).toString();
const FILE_LEAF = moveTrashLeafPath("/.trash", "/docs/a.txt", "file", LEAF);
const DIR_LEAF = moveTrashLeafPath("/.trash", "/docs/2026", "dir", LEAF);
const idFor = (path: string) => path.slice("/.trash/".length);

function storageWith(files: Record<string, string> = {}) {
  return createMemoryStorage(files, { clock: () => AT });
}

describe("TrashProvider.put", () => {
  it("moves a file into the layout the Trash lists back, and says where", async () => {
    const storage = storageWith({ "/docs/a.txt": "hello" });
    expect(await storage.trash.put("/docs/a.txt")).toEqual({ leaf: FILE_LEAF, kind: "file" });
    expect(storage.dump()).toEqual({ [FILE_LEAF]: "hello" });

    const listing = await storage.trash.list();
    expect(listing.entries.map((entry) => entry.originalPath)).toEqual(["/docs/a.txt"]);
    await storage.trash.restore(idFor(FILE_LEAF));
    expect(storage.dump()).toEqual({ "/docs/a.txt": "hello" });
  });

  it("round-trips numeric, Unicode, percent, and maximum-length path segments", async () => {
    const originalPath = `/2026/Å %20/${"x".repeat(255)}`;
    const storage = storageWith({ [originalPath]: "hello" });

    await storage.trash.put(originalPath);
    const [entry] = (await storage.trash.list()).entries;
    expect(entry?.originalPath).toBe(originalPath);

    await storage.trash.restore(entry?.id ?? "missing");
    expect(storage.dump()).toEqual({ [originalPath]: "hello" });
  });

  it("moves a folder with its contents, finding its kind itself", async () => {
    const storage = storageWith({ "/docs/2026/b.txt": "b", "/top.txt": "t" });
    expect(await storage.trash.put("/docs/2026")).toEqual({ leaf: DIR_LEAF, kind: "dir" });
    await storage.trash.put("/top.txt");
    const topLeaf = moveTrashLeafPath("/.trash", "/top.txt", "file", LEAF);
    expect(storage.dump()).toEqual({ [`${DIR_LEAF}/b.txt`]: "b", [topLeaf]: "t" });

    const restored = await storage.trash.restore(idFor(DIR_LEAF));
    expect(restored).toMatchObject({ path: "/docs/2026", kind: "dir" });
    expect(storage.dump()).toEqual({ "/docs/2026/b.txt": "b", [topLeaf]: "t" });
  });

  it("round-trips an empty folder", async () => {
    const storage = storageWith();
    await storage.mkdir("/empty");
    await storage.trash.put("/empty");
    expect((await storage.trash.list()).entries.map((entry) => entry.originalPath)).toEqual([
      "/empty",
    ]);
    await storage.trash.restore(idFor(moveTrashLeafPath("/.trash", "/empty", "dir", LEAF)));
    expect(storage.dirs()).toContain("/empty");
  });

  it("keeps the item when the move fails or its leaf is taken", async () => {
    const failing = storageWith({ "/docs/keep.txt": "keep" });
    failing.move = async () => {
      throw new Error("move failed");
    };
    await expect(failing.trash.put("/docs")).rejects.toThrow("move failed");
    expect(failing.dump()).toEqual({ "/docs/keep.txt": "keep" });

    const taken = storageWith({
      "/docs/2026/keep.txt": "keep",
      [`${DIR_LEAF}/older.txt`]: "older trash item",
    });
    await expect(taken.trash.put("/docs/2026")).rejects.toMatchObject({ kind: "conflict" });
    expect(taken.dump()).toMatchObject({ "/docs/2026/keep.txt": "keep" });
  });

  it("asks storage to refuse a taken leaf rather than replace it", async () => {
    const storage = storageWith({ "/docs/a.txt": "hello" });
    const moves: unknown[] = [];
    const originalMove = storage.move.bind(storage);
    storage.move = async (path, target, opts) => {
      moves.push(opts);
      return originalMove(path, target, opts);
    };
    await storage.trash.put("/docs/a.txt");
    expect(moves).toEqual([{ overwrite: false }]);
  });

  it.each(["/", "/.trash", "/.trash/docs/a.txt", "/.fdrive-desktop/x", "/old/.fdrive-move-v1/x"])(
    "refuses %s: the root and fdrive's own folders never go to Trash",
    async (path) => {
      const storage = storageWith({ "/.trash/docs/a.txt": "kept", "/.fdrive-desktop/x": "kept" });
      await expect(storage.trash.put(path)).rejects.toMatchObject({ kind: "bad_request" });
      expect(storage.dump()).toMatchObject({ "/.trash/docs/a.txt": "kept" });
    },
  );

  it("refuses what is not there", async () => {
    await expect(storageWith().trash.put("/missing.txt")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("leaves deleting to deleteFile and deleteDir, which delete for good", async () => {
    const storage = storageWith({ "/docs/a.txt": "a", "/docs/2026/b.txt": "b" });
    await storage.deleteFile("/docs/a.txt");
    await storage.deleteDir("/docs/2026");
    expect(storage.dump()).toEqual({});
    expect((await storage.trash.list()).entries).toEqual([]);
  });
});
