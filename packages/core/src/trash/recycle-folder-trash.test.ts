import { describe, expect, it } from "vitest";
import type { FileEntry } from "../entries.ts";
import { isStorageError, StorageError } from "../errors.ts";
import { parentPath } from "../paths.ts";
import { createMemoryStorage } from "../testing/memory-storage.ts";
import { moveTrashLeafPath, moveTrashRootPath } from "./recycle-folder.ts";
import { createRecycleFolderTrash } from "./recycle-folder-trash.ts";

const TRASH_PATH = "/.trash";
const NAMESPACE = moveTrashRootPath(TRASH_PATH);

/** A leaf as `withMoveToTrash` writes it: its storage path and its `TrashEntry.id`. */
function leaf(originalPath: string, timestamp: string, kind: "file" | "dir" = "file") {
  const path = moveTrashLeafPath(TRASH_PATH, originalPath, kind, timestamp);
  return { path, id: path.slice(`${TRASH_PATH}/`.length) };
}

const A = leaf("/docs/a.txt", "1000000");
const A2 = leaf("/docs/a.txt", "2000000");
const TOP = leaf("/top.txt", "2000000");
const DOCS = leaf("/docs", "1000000", "dir");

function trashFor(storage: ReturnType<typeof createMemoryStorage>, limit?: number) {
  return createRecycleFolderTrash({
    storage,
    trashPath: TRASH_PATH,
    ...(limit === undefined ? {} : { limit }),
  });
}

/** The layout folders between the namespace and each leaf, as the layout makes them. */
function foldersAbove(...leafPaths: string[]): string[] {
  const folders = new Set<string>();
  for (const leafPath of leafPaths) {
    for (let at = parentPath(leafPath); at !== NAMESPACE; at = parentPath(at)) folders.add(at);
  }
  return [...folders].sort();
}

/** Every folder storage holds below the namespace. */
function layoutFolders(storage: ReturnType<typeof createMemoryStorage>): string[] {
  return storage.dirs().filter((dir) => dir.startsWith(`${NAMESPACE}/`));
}

/** A folder of the layout without a leaf: what restores and purges used to leave behind. */
const LEFTOVER = `${NAMESPACE}/file/p/old/p/gone.txt/v`;
const LEFTOVER_BESIDE_A = `${NAMESPACE}/file/p/docs/p/b.txt/v`;

describe("createRecycleFolderTrash: list", () => {
  it("returns an empty, non-truncated listing before anything was deleted", async () => {
    const storage = createMemoryStorage();
    await storage.mkdir(TRASH_PATH);

    await expect(trashFor(storage).list()).resolves.toEqual({ entries: [], truncated: false });
  });

  it("propagates a namespace listing failure other than not_found", async () => {
    const storage = createMemoryStorage();
    storage.list = async () => {
      throw new StorageError("forbidden", "no trash access");
    };

    await expect(trashFor(storage).list()).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("skips a folder that is gone by the time the walk reaches it", async () => {
    const storage = createMemoryStorage({ [A.path]: "a", [TOP.path]: "top" });
    const originalList = storage.list.bind(storage);
    storage.list = async (path: string) => {
      if (path === parentPath(A.path)) throw new StorageError("not_found", `gone: ${path}`);
      return originalList(path);
    };

    const listing = await trashFor(storage).list();

    expect(listing).toEqual({
      entries: [expect.objectContaining({ id: TOP.id })],
      truncated: false,
    });
  });

  it("propagates a failure to list a folder below the namespace", async () => {
    const storage = createMemoryStorage({ [A.path]: "a" });
    const originalList = storage.list.bind(storage);
    storage.list = async (path: string) => {
      if (path !== NAMESPACE) throw new StorageError("forbidden", `denied: ${path}`);
      return originalList(path);
    };

    await expect(trashFor(storage).list()).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("lists a top-level and a nested leaf, parsing name, originalPath, size, and deletedAt", async () => {
    const storage = createMemoryStorage({ [TOP.path]: "top", [A.path]: "hello a" });

    const listing = await trashFor(storage).list();

    expect(listing.truncated).toBe(false);
    expect(listing.entries).toEqual([
      {
        id: TOP.id,
        originalPath: "/top.txt",
        name: "top.txt",
        size: 3,
        deletedAt: new Date(2),
      },
      {
        id: A.id,
        originalPath: "/docs/a.txt",
        name: "a.txt",
        size: 7,
        deletedAt: new Date(1),
      },
    ]);
  });

  it("lists a deleted directory as one leaf without walking its contents", async () => {
    const storage = createMemoryStorage({ [`${DOCS.path}/sub/file.txt`]: "inside" });
    const listedPaths: string[] = [];
    const originalList = storage.list.bind(storage);
    storage.list = async (path: string) => {
      listedPaths.push(path);
      return originalList(path);
    };

    const listing = await trashFor(storage).list();

    expect(listing).toMatchObject({
      entries: [{ id: DOCS.id, originalPath: "/docs", name: "docs", size: 0 }],
      truncated: false,
    });
    expect(listedPaths).not.toContain(DOCS.path);
  });

  it("lists only fdrive's own leaves, never other items in the trash folder", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/docs/old.txt/1000000`]: "put there by another tool",
      [`${TRASH_PATH}/notes.txt`]: "stray",
      [A.path]: "hello a",
    });

    const listing = await trashFor(storage).list();

    expect(listing.entries.map((entry) => entry.id)).toEqual([A.id]);
  });

  it("skips a leaf whose kind differs from the one its path names", async () => {
    const storage = createMemoryStorage({ [`${A.path}/inside.txt`]: "a folder at a file leaf" });

    await expect(trashFor(storage).list()).resolves.toEqual({ entries: [], truncated: false });
  });

  it("sorts by deletedAt descending, then by id", async () => {
    const a = leaf("/a.txt", "1000000");
    const b = leaf("/b.txt", "3000000");
    const c = leaf("/c.txt", "2000000");
    const storage = createMemoryStorage({ [a.path]: "a", [b.path]: "b", [c.path]: "c" });

    const listing = await trashFor(storage).list();

    expect(listing.entries.map((entry) => entry.name)).toEqual(["b.txt", "c.txt", "a.txt"]);
  });

  it("breaks ties on the same deletedAt by id", async () => {
    const a = leaf("/a.txt", "1000000");
    const b = leaf("/b.txt", "1000000");
    const storage = createMemoryStorage({ [b.path]: "b", [a.path]: "a" });

    const listing = await trashFor(storage).list();

    expect(listing.entries.map((entry) => entry.id)).toEqual([a.id, b.id]);
  });

  it("skips anything in the namespace that does not parse as a leaf", async () => {
    const storage = createMemoryStorage({
      [`${NAMESPACE}/file/p/docs/v/not-a-time`]: "junk",
      [TOP.path]: "top",
    });

    const listing = await trashFor(storage).list();

    expect(listing.entries.map((entry) => entry.name)).toEqual(["top.txt"]);
  });

  it("skips a non-file, non-dir entry (a symlink) reported by the provider", async () => {
    const storage = createMemoryStorage({ [TOP.path]: "top" });
    const originalList = storage.list.bind(storage);
    storage.list = async (path: string) => {
      const entries = await originalList(path);
      if (path !== parentPath(TOP.path)) {
        return entries;
      }
      return [
        ...entries,
        {
          name: "3000000",
          path: `${parentPath(TOP.path)}/3000000`,
          kind: "symlink" as const,
          size: 0,
          modifiedAt: new Date(0),
          ext: "",
        },
      ];
    };

    const listing = await trashFor(storage).list();

    expect(listing.entries.map((entry) => entry.id)).toEqual([TOP.id]);
  });

  it("truncates at the configured entry limit", async () => {
    const storage = createMemoryStorage(
      Object.fromEntries(
        ["1000000", "2000000", "3000000"].map((at) => [leaf(`/${at}.txt`, at).path, at]),
      ),
    );

    const listing = await trashFor(storage, 2).list();

    expect(listing.entries).toHaveLength(2);
    expect(listing.truncated).toBe(true);
  });

  it("a per-call limit overrides the provider's default", async () => {
    const storage = createMemoryStorage({ [A.path]: "a", [TOP.path]: "top" });

    const listing = await trashFor(storage).list({ limit: 1 });

    expect(listing.entries).toHaveLength(1);
    expect(listing.truncated).toBe(true);
  });

  it("stops visiting further queued directories once the entry limit is hit", async () => {
    const storage = createMemoryStorage({
      [leaf("/dirA/a1.txt", "1000000").path]: "a1",
      [leaf("/dirA/a2.txt", "2000000").path]: "a2",
      [leaf("/dirB/b1.txt", "3000000").path]: "b1",
    });

    const listing = await trashFor(storage, 1).list();

    expect(listing.truncated).toBe(true);
    expect(listing.entries).toHaveLength(1);
  });

  it("lists every leaf past more empty folders than a listing used to visit", async () => {
    // Listings stopped after 10,000 folders, and leftover empty folders came
    // first. Synthesize just that many once, rather than materializing them in
    // memory storage or rebuilding them per call: the walk only calls list,
    // and on a loaded CI runner every visit counts.
    const storage = createMemoryStorage({ [A.path]: "a", [TOP.path]: "top" });
    const leftovers = Array.from(
      { length: 10_000 },
      (_, i): FileEntry => ({
        name: `e${i}`,
        path: `${NAMESPACE}/e${i}`,
        kind: "dir",
        size: 0,
        modifiedAt: new Date(0),
        ext: "",
      }),
    );
    const namespace = [...leftovers, ...(await storage.list(NAMESPACE))];
    const originalList = storage.list.bind(storage);
    storage.list = async (path: string) => {
      if (path === NAMESPACE) return namespace;
      return path.startsWith(`${NAMESPACE}/e`) ? [] : originalList(path);
    };

    const listing = await trashFor(storage).list();

    expect(listing).toEqual({
      entries: [expect.objectContaining({ id: TOP.id }), expect.objectContaining({ id: A.id })],
      truncated: false,
    });
  });

  it("leaves empty folders alone unless asked to prune", async () => {
    const storage = createMemoryStorage({ [A.path]: "a" });
    await storage.mkdir(LEFTOVER, { parents: true });
    const before = layoutFolders(storage);

    await trashFor(storage).list();

    expect(layoutFolders(storage)).toEqual(before);
  });

  it("with prune, removes the empty folders it passes and keeps every leaf's", async () => {
    const storage = createMemoryStorage({ [A.path]: "a", [TOP.path]: "top" });
    await storage.mkdir(LEFTOVER, { parents: true });
    await storage.mkdir(LEFTOVER_BESIDE_A, { parents: true });
    await storage.mkdir(`${NAMESPACE}/dir`, { parents: true });

    const listing = await trashFor(storage).list({ prune: true });

    expect(listing.entries.map((entry) => entry.id)).toEqual([TOP.id, A.id]);
    expect(layoutFolders(storage)).toEqual(foldersAbove(A.path, TOP.path));
    expect(storage.dirs()).toContain(NAMESPACE);
  });

  it("with prune, lists every leaf even when an empty folder cannot be removed", async () => {
    const storage = createMemoryStorage({ [A.path]: "a" });
    await storage.mkdir(LEFTOVER, { parents: true });
    storage.deleteEmptyDir = async () => {
      throw new StorageError("forbidden", "denied");
    };

    const listing = await trashFor(storage).list({ prune: true });

    expect(listing.entries.map((entry) => entry.id)).toEqual([A.id]);
    expect(storage.dirs()).toContain(LEFTOVER);
  });

  it("throws AbortError immediately for an already-aborted signal", async () => {
    const storage = createMemoryStorage({ [TOP.path]: "top" });
    const controller = new AbortController();
    controller.abort();

    await expect(trashFor(storage).list({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("throws AbortError once the signal aborts mid-walk", async () => {
    const storage = createMemoryStorage({ [A.path]: "a", [TOP.path]: "top" });
    const controller = new AbortController();
    const originalList = storage.list.bind(storage);
    let calls = 0;
    storage.list = async (path: string) => {
      calls += 1;
      if (calls > 1) {
        controller.abort();
      }
      return originalList(path);
    };

    await expect(trashFor(storage).list({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("createRecycleFolderTrash: restore", () => {
  it("restores a leaf to its original path by default", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a" });

    const restored = await trashFor(storage).restore(A.id);

    expect(restored).toMatchObject({
      path: "/docs/a.txt",
      name: "a.txt",
      kind: "file",
      size: 7,
      originalPath: "/docs/a.txt",
    });
    expect(storage.dump()).toEqual({ "/docs/a.txt": "hello a" });
  });

  it("restores to an explicit target, creating parent directories", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a" });

    const restored = await trashFor(storage).restore(A.id, { target: "/new/place/a.txt" });

    expect(restored.path).toBe("/new/place/a.txt");
    expect(restored.originalPath).toBe("/docs/a.txt");
    expect(storage.dump()).toEqual({ "/new/place/a.txt": "hello a" });
  });

  it("restores a directory leaf with its contents", async () => {
    const storage = createMemoryStorage({
      [`${DOCS.path}/a.txt`]: "a",
      [`${DOCS.path}/sub/b.txt`]: "b",
    });
    const trash = trashFor(storage);

    const restored = await trash.restore(DOCS.id);

    expect(restored).toMatchObject({
      path: "/docs",
      originalPath: "/docs",
      name: "docs",
      kind: "dir",
      size: 0,
    });
    expect(storage.dump()).toEqual({ "/docs/a.txt": "a", "/docs/sub/b.txt": "b" });
    expect((await trash.list()).entries).toEqual([]);
  });

  it("rejects a folder of the layout that is not a leaf before mutating it", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a" });
    const folderId = parentPath(A.path).slice(`${TRASH_PATH}/`.length);

    await expect(trashFor(storage).restore(folderId)).rejects.toMatchObject({
      kind: "bad_request",
    });
    expect(storage.dump()).toEqual({ [A.path]: "hello a" });
  });

  it("rejects an item outside fdrive's layout before mutating it", async () => {
    const other = `${TRASH_PATH}/docs/a.txt/1000000`;
    const storage = createMemoryStorage({ [other]: "put there by another tool" });

    await expect(trashFor(storage).restore("docs/a.txt/1000000")).rejects.toMatchObject({
      kind: "bad_request",
    });
    expect(storage.dump()).toEqual({ [other]: "put there by another tool" });
    expect(storage.dirs()).not.toContain("/docs");
  });

  it("rejects a leaf whose kind differs from the one its path names, before mutation", async () => {
    const storage = createMemoryStorage({ [A.path]: "link" });
    const originalStat = storage.stat.bind(storage);
    storage.stat = async (path: string) => {
      const stat = await originalStat(path);
      return path === A.path ? { ...stat, kind: "symlink" } : stat;
    };

    await expect(trashFor(storage).restore(A.id)).rejects.toMatchObject({ kind: "bad_request" });
    expect(storage.dump()).toEqual({ [A.path]: "link" });
  });

  it("falls back to a zero mtime when the provider reports none", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a" }, { nullMtimePaths: [A.path] });

    const restored = await trashFor(storage).restore(A.id);

    expect(restored.modifiedAt).toEqual(new Date(0));
  });

  it("removes the folders the restored leaf leaves empty, up to the namespace", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a", [TOP.path]: "top" });

    await trashFor(storage).restore(A.id);

    expect(layoutFolders(storage)).toEqual(foldersAbove(TOP.path));
    expect(storage.dirs()).toContain(NAMESPACE);
  });

  it("keeps a sibling version of the same path in Trash, and its folders", async () => {
    const storage = createMemoryStorage({ [A.path]: "version one", [A2.path]: "version two" });
    const trash = trashFor(storage);

    await trash.restore(A.id);

    expect((await trash.list()).entries.map((entry) => entry.id)).toEqual([A2.id]);
    expect(layoutFolders(storage)).toEqual(foldersAbove(A2.path));
  });

  it("restores even when a folder it leaves empty cannot be removed", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a" });
    storage.deleteEmptyDir = async () => {
      throw new StorageError("forbidden", "denied");
    };

    await expect(trashFor(storage).restore(A.id)).resolves.toMatchObject({ path: "/docs/a.txt" });
    expect(storage.dirs()).toContain(parentPath(A.path));
  });

  it("throws bad_request for an id that does not parse", async () => {
    const storage = createMemoryStorage();

    await expect(trashFor(storage).restore("not-a-leaf")).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("asks storage to refuse an occupied target rather than replace it", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a" });
    const moves: unknown[] = [];
    const originalMove = storage.move.bind(storage);
    storage.move = async (path, target, opts) => {
      moves.push(opts);
      return originalMove(path, target, opts);
    };

    await trashFor(storage).restore(A.id);

    expect(moves).toEqual([{ overwrite: false }]);
  });

  it("throws conflict, without moving or deleting anything, when a file already exists at the target", async () => {
    const storage = createMemoryStorage({ [A.path]: "trashed", "/docs/a.txt": "already here" });

    await expect(trashFor(storage).restore(A.id)).rejects.toSatisfy(
      (error: unknown) => isStorageError(error) && error.kind === "conflict",
    );
    expect(storage.dump()).toEqual({ [A.path]: "trashed", "/docs/a.txt": "already here" });
  });

  it("throws conflict, without moving anything, when a directory already exists at the target", async () => {
    const storage = createMemoryStorage({ [A.path]: "trashed" });
    await storage.mkdir("/docs/a.txt", { parents: true });

    await expect(trashFor(storage).restore(A.id)).rejects.toSatisfy(
      (error: unknown) => isStorageError(error) && error.kind === "conflict",
    );
    expect(storage.dirs()).toContain("/docs/a.txt");
    expect(storage.dump()).toEqual({ [A.path]: "trashed" });
  });

  it("refuses to restore into the trash folder itself or below it", async () => {
    const storage = createMemoryStorage({ [A.path]: "a" });
    const trash = trashFor(storage);
    for (const target of ["/.trash", "/.trash/docs/a.txt", "/.trash/elsewhere.txt"]) {
      await expect(trash.restore(A.id, { target })).rejects.toMatchObject({ kind: "bad_request" });
    }
    expect(storage.dump()).toEqual({ [A.path]: "a" });
  });
});

describe("createRecycleFolderTrash: purge", () => {
  it("permanently deletes the given leaves", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a", [TOP.path]: "top" });
    const trash = trashFor(storage);

    await trash.purge(A.id);

    expect((await trash.list()).entries.map((entry) => entry.id)).toEqual([TOP.id]);
  });

  it("permanently deletes a directory leaf and its contents", async () => {
    const storage = createMemoryStorage({ [`${DOCS.path}/sub/file.txt`]: "inside" });
    const trash = trashFor(storage);

    await trash.purge(DOCS.id);

    expect(storage.dump()).toEqual({});
    expect((await trash.list()).entries).toEqual([]);
  });

  it("refuses to purge a folder of the layout that is not a leaf", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a" });
    const folderId = parentPath(A.path).slice(`${TRASH_PATH}/`.length);

    await expect(trashFor(storage).purge(folderId)).rejects.toMatchObject({
      kind: "bad_request",
    });
    expect(storage.dump()).toEqual({ [A.path]: "hello a" });
  });

  it("refuses to purge an item outside fdrive's layout", async () => {
    const other = `${TRASH_PATH}/docs/a.txt/1000000`;
    const storage = createMemoryStorage({ [other]: "put there by another tool" });

    await expect(trashFor(storage).purge("docs/a.txt/1000000")).rejects.toMatchObject({
      kind: "bad_request",
    });
    expect(storage.dump()).toEqual({ [other]: "put there by another tool" });
  });

  it("ignores ids that are already gone", async () => {
    const storage = createMemoryStorage({ [TOP.path]: "top" });

    await expect(
      trashFor(storage).purge(leaf("/docs/missing.txt", "9999999").id),
    ).resolves.toBeUndefined();
  });

  it("ignores a file leaf that disappears between stat and deletion", async () => {
    const storage = createMemoryStorage({ [TOP.path]: "top" });
    const originalStat = storage.stat.bind(storage);
    const originalDeleteFile = storage.deleteFile.bind(storage);
    storage.stat = async (path: string) => {
      const stat = await originalStat(path);
      if (path === TOP.path) {
        await originalDeleteFile(path);
      }
      return stat;
    };

    await expect(trashFor(storage).purge(TOP.id)).resolves.toBeUndefined();
  });

  it("removes the folders the purged leaf leaves empty, up to the namespace", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a", [TOP.path]: "top" });
    const trash = trashFor(storage);

    await trash.purge(A.id);
    expect(layoutFolders(storage)).toEqual(foldersAbove(TOP.path));

    await trash.purge(TOP.id);
    expect(layoutFolders(storage)).toEqual([]);
    expect(storage.dirs()).toContain(NAMESPACE);
  });

  it("never removes a folder something was moved into meanwhile", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a" });
    const originalDeleteFile = storage.deleteFile.bind(storage);
    storage.deleteFile = async (path: string) => {
      await originalDeleteFile(path);
      // A delete of the same path lands beside the purged leaf before its folders go.
      await storage.upload(A2.path, new TextEncoder().encode("deleted again"));
    };
    const trash = trashFor(storage);

    await trash.purge(A.id);

    expect(storage.dump()).toEqual({ [A2.path]: "deleted again" });
    expect((await trash.list()).entries.map((entry) => entry.id)).toEqual([A2.id]);
  });

  it("propagates a deleteFile failure that is not a not_found StorageError", async () => {
    const storage = createMemoryStorage({ [A.path]: "hello a" });
    storage.deleteFile = async () => {
      throw new Error("disk on fire");
    };

    await expect(trashFor(storage).purge(A.id)).rejects.toThrow("disk on fire");
  });
});
