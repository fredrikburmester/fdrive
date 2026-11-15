import { describe, expect, it } from "vitest";
import { StorageError } from "../errors.ts";
import { createMemoryStorage } from "../testing/memory-storage.ts";
import { createTrash, isTrashId, trashItemFolder, trashItemOf, trashItemPath } from "./trash.ts";

const ID = "0d9f8a52-6c1e-4f53-9a7b-2e4c6d8f0a1b";
const OTHER = "7a4b2c1d-3e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("Trash item paths", () => {
  it("puts each item in a folder of its own, named by its id", () => {
    expect(trashItemFolder(ID)).toBe(`/.trash/${ID}`);
    expect(trashItemPath(ID, "a.txt")).toBe(`/.trash/${ID}/a.txt`);
  });

  it("takes only ids fdrive makes", () => {
    expect(isTrashId(ID)).toBe(true);
    for (const id of ["", "docs/a.txt/1", ID.toUpperCase(), `${ID}/x`, "../x"])
      expect(isTrashId(id)).toBe(false);
    expect(() => trashItemFolder("../docs")).toThrow(StorageError);
  });

  it("finds the item a path is or lies in", () => {
    const item = { id: ID, path: `/.trash/${ID}/Å %20.txt` };
    expect(trashItemOf(`/.trash/${ID}/Å %20.txt`)).toEqual(item);
    expect(trashItemOf(`/.trash/${ID}/Å %20.txt/inside/deep.txt`)).toEqual(item);
    for (const path of [
      "/.trash",
      `/.trash/${ID}`,
      "/.trash/not-an-id/a.txt",
      `/docs/${ID}/a.txt`,
      `/.Trash/${ID}/a.txt`,
    ])
      expect(trashItemOf(path)).toBeNull();
  });
});

describe("createTrash", () => {
  it("moves a file into its folder and back to where it was", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "hello" });
    expect(await storage.trash.put("/docs/a.txt", ID)).toEqual({
      leaf: `/.trash/${ID}/a.txt`,
      kind: "file",
    });
    expect(storage.dump()).toEqual({ [`/.trash/${ID}/a.txt`]: "hello" });

    expect(await storage.trash.restore(ID, "a.txt", "/docs/a.txt")).toMatchObject({
      path: "/docs/a.txt",
      kind: "file",
    });
    expect(storage.dump()).toEqual({ "/docs/a.txt": "hello" });
    expect(storage.dirs()).not.toContain(`/.trash/${ID}`);
  });

  it("moves a folder with its contents, finding its kind itself", async () => {
    const storage = createMemoryStorage({ "/docs/2026/b.txt": "b" });
    expect(await storage.trash.put("/docs/2026", ID)).toEqual({
      leaf: `/.trash/${ID}/2026`,
      kind: "dir",
    });
    expect(storage.dump()).toEqual({ [`/.trash/${ID}/2026/b.txt`]: "b" });
  });

  it("keeps a name as it is, however long, Unicode or percent-laden", async () => {
    const name = `Å %20 ${"x".repeat(240)}`;
    const deep = `/${Array.from({ length: 40 }, (_, at) => `folder-${at}`).join("/")}/${name}`;
    const storage = createMemoryStorage({ [deep]: "deep" });
    const { leaf } = await storage.trash.put(deep, ID);
    expect(leaf).toBe(`/.trash/${ID}/${name}`);
    await storage.trash.restore(ID, name, deep);
    expect(storage.dump()).toEqual({ [deep]: "deep" });
  });

  it("restores elsewhere, making missing folders, and never over anything", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "trashed", "/taken.txt": "kept" });
    await storage.trash.put("/docs/a.txt", ID);
    await expect(storage.trash.restore(ID, "a.txt", "/taken.txt")).rejects.toMatchObject({
      kind: "conflict",
    });
    expect(storage.dump()).toMatchObject({ "/taken.txt": "kept" });
    await storage.trash.restore(ID, "a.txt", "/new/place/a.txt");
    expect(storage.dump()).toEqual({ "/taken.txt": "kept", "/new/place/a.txt": "trashed" });
  });

  it("refuses a restore into Trash or of an item that is not there, making nothing", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "a" });
    await storage.trash.put("/docs/a.txt", ID);
    await expect(
      storage.trash.restore(ID, "a.txt", `/.trash/${OTHER}/a.txt`),
    ).rejects.toMatchObject({ kind: "bad_request" });
    await expect(storage.trash.restore(OTHER, "a.txt", "/made/a.txt")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(storage.dirs()).not.toContain("/made");
  });

  it("purges an item with its folder, and ignores one already gone", async () => {
    const storage = createMemoryStorage({ "/docs/2026/b.txt": "b", "/keep.txt": "k" });
    await storage.trash.put("/docs/2026", ID);
    await storage.trash.purge(ID);
    await storage.trash.purge(ID);
    expect(storage.dump()).toEqual({ "/keep.txt": "k" });
    expect(storage.dirs()).not.toContain(`/.trash/${ID}`);
  });

  it("passes on a purge failure other than not_found", async () => {
    const storage = createMemoryStorage({ "/a.txt": "a" });
    storage.deleteDir = async () => {
      throw new StorageError("forbidden", "no");
    };
    await expect(createTrash(storage).purge(ID)).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("keeps the item where it was, and no folder for it, when the move fails", async () => {
    const storage = createMemoryStorage({ "/docs/keep.txt": "keep" });
    storage.move = async () => {
      throw new StorageError("conflict", "taken");
    };
    await expect(createTrash(storage).put("/docs", ID)).rejects.toMatchObject({
      kind: "conflict",
    });
    expect(storage.dump()).toEqual({ "/docs/keep.txt": "keep" });
    expect(storage.dirs()).not.toContain(`/.trash/${ID}`);
  });

  it("asks storage to refuse a taken name rather than replace it", async () => {
    const storage = createMemoryStorage({ "/a.txt": "a" });
    const moves: unknown[] = [];
    const move = storage.move.bind(storage);
    storage.move = async (path, target, opts) => {
      moves.push(opts);
      return move(path, target, opts);
    };
    await createTrash(storage).put("/a.txt", ID);
    expect(moves).toEqual([{ overwrite: false }]);
  });

  it.each(["/", "/.trash", `/.trash/${OTHER}/a.txt`, "/.fdrive-desktop/x"])(
    "refuses %s: the root and fdrive's own folders never go to Trash",
    async (path) => {
      const storage = createMemoryStorage({
        [`/.trash/${OTHER}/a.txt`]: "kept",
        "/.fdrive-desktop/x": "kept",
      });
      await expect(storage.trash.put(path, ID)).rejects.toMatchObject({ kind: "bad_request" });
      expect(storage.dump()).toMatchObject({ [`/.trash/${OTHER}/a.txt`]: "kept" });
    },
  );

  it("refuses what is not there, and an id it did not make", async () => {
    const storage = createMemoryStorage({ "/a.txt": "a" });
    await expect(storage.trash.put("/missing.txt", ID)).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(storage.trash.put("/a.txt", "../../escape")).rejects.toMatchObject({
      kind: "bad_request",
    });
    expect(storage.dump()).toEqual({ "/a.txt": "a" });
  });

  it("leaves deleting to deleteFile and deleteDir, which delete for good", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "a", "/docs/2026/b.txt": "b" });
    await storage.deleteFile("/docs/a.txt");
    await storage.deleteDir("/docs/2026");
    expect(storage.dump()).toEqual({});
    expect(storage.dirs()).not.toContain("/.trash");
  });
});
