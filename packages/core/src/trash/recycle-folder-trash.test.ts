import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../../test/fixtures/memory-storage.ts";
import { isStorageError } from "../errors.ts";
import { createRecycleFolderTrash } from "./recycle-folder-trash.ts";

const TRASH_PATH = "/.trash";

describe("createRecycleFolderTrash: list", () => {
  it("returns an empty, non-truncated listing for an empty trash", async () => {
    const storage = createMemoryStorage();
    await storage.mkdir(TRASH_PATH);
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    const listing = await trash.list();

    expect(listing).toEqual({ entries: [], truncated: false });
  });

  it("lists a top-level and a nested leaf, parsing name, originalPath, size, and deletedAt", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/top.txt/1000000`]: "top",
      [`${TRASH_PATH}/docs/a.txt/2000000`]: "hello a",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    const listing = await trash.list();

    expect(listing.truncated).toBe(false);
    expect(listing.entries).toHaveLength(2);
    const byName = new Map(listing.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("top.txt")).toMatchObject({
      id: "top.txt/1000000",
      originalPath: "/top.txt",
      name: "top.txt",
      size: 3,
    });
    expect(byName.get("a.txt")).toMatchObject({
      id: "docs/a.txt/2000000",
      originalPath: "/docs/a.txt",
      name: "a.txt",
      size: 7,
    });
  });

  it("sorts by deletedAt descending, then by id", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/a.txt/1000000`]: "a",
      [`${TRASH_PATH}/b.txt/3000000`]: "b",
      [`${TRASH_PATH}/c.txt/2000000`]: "c",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    const listing = await trash.list();

    expect(listing.entries.map((entry) => entry.name)).toEqual(["b.txt", "c.txt", "a.txt"]);
  });

  it("breaks ties on the same deletedAt by id", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/b.txt/1000000`]: "b",
      [`${TRASH_PATH}/a.txt/1000000`]: "a",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    const listing = await trash.list();

    expect(listing.entries.map((entry) => entry.id)).toEqual(["a.txt/1000000", "b.txt/1000000"]);
  });

  it("skips anything under the trash root that does not parse as a leaf", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/not-a-timestamp/notdigits`]: "junk",
      [`${TRASH_PATH}/top.txt/1000000`]: "top",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    const listing = await trash.list();

    expect(listing.entries.map((entry) => entry.name)).toEqual(["top.txt"]);
  });

  it("skips a non-file, non-dir entry (a symlink) reported by the provider", async () => {
    const storage = createMemoryStorage({ [`${TRASH_PATH}/top.txt/1000000`]: "top" });
    const originalList = storage.list.bind(storage);
    storage.list = async (path: string) => {
      const entries = await originalList(path);
      if (path !== TRASH_PATH) {
        return entries;
      }
      return [
        ...entries,
        {
          name: "a-symlink",
          path: `${TRASH_PATH}/a-symlink`,
          kind: "symlink" as const,
          size: 0,
          modifiedAt: new Date(0),
          ext: "",
        },
      ];
    };
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    const listing = await trash.list();

    expect(listing.entries.map((entry) => entry.name)).toEqual(["top.txt"]);
  });

  it("truncates at the configured entry limit", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/a.txt/1000000`]: "a",
      [`${TRASH_PATH}/b.txt/2000000`]: "b",
      [`${TRASH_PATH}/c.txt/3000000`]: "c",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH, limit: 2 });

    const listing = await trash.list();

    expect(listing.entries).toHaveLength(2);
    expect(listing.truncated).toBe(true);
  });

  it("a per-call limit overrides the provider's default", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/a.txt/1000000`]: "a",
      [`${TRASH_PATH}/b.txt/2000000`]: "b",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    const listing = await trash.list({ limit: 1 });

    expect(listing.entries).toHaveLength(1);
    expect(listing.truncated).toBe(true);
  });

  it("stops visiting further queued directories once the entry limit is hit", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/dirA/a1.txt/1000000`]: "a1",
      [`${TRASH_PATH}/dirA/a2.txt/2000000`]: "a2",
      [`${TRASH_PATH}/dirB/b1.txt/3000000`]: "b1",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH, limit: 1 });

    const listing = await trash.list();

    expect(listing.truncated).toBe(true);
    expect(listing.entries.every((entry) => entry.originalPath.startsWith("/dirA/"))).toBe(true);
  });

  it("truncates once the directory-visit bound is hit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10_005; i += 1) {
      files[`${TRASH_PATH}/d${i}/f.txt/1000000`] = "x";
    }
    const storage = createMemoryStorage(files);
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    const listing = await trash.list({ limit: 1_000_000 });

    expect(listing.truncated).toBe(true);
    expect(listing.entries.length).toBeLessThan(10_005);
  });

  it("throws AbortError immediately for an already-aborted signal", async () => {
    const storage = createMemoryStorage({ [`${TRASH_PATH}/top.txt/1000000`]: "top" });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });
    const controller = new AbortController();
    controller.abort();

    await expect(trash.list({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("throws AbortError once the signal aborts mid-walk", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/a/x.txt/1000000`]: "a",
      [`${TRASH_PATH}/b/y.txt/2000000`]: "b",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });
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

    await expect(trash.list({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("createRecycleFolderTrash: restore", () => {
  it("restores a leaf to its original path by default", async () => {
    const storage = createMemoryStorage({ [`${TRASH_PATH}/docs/a.txt/1000000`]: "hello a" });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    const restored = await trash.restore("docs/a.txt/1000000");

    expect(restored.path).toBe("/docs/a.txt");
    expect(restored.name).toBe("a.txt");
    expect(restored.kind).toBe("file");
    expect(restored.size).toBe(7);
    expect(storage.dump()).toEqual({ "/docs/a.txt": "hello a" });
  });

  it("restores to an explicit target, creating parent directories", async () => {
    const storage = createMemoryStorage({ [`${TRASH_PATH}/docs/a.txt/1000000`]: "hello a" });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    const restored = await trash.restore("docs/a.txt/1000000", { target: "/new/place/a.txt" });

    expect(restored.path).toBe("/new/place/a.txt");
    expect(storage.dump()).toEqual({ "/new/place/a.txt": "hello a" });
  });

  it("falls back to a zero mtime when the provider reports none", async () => {
    const storage = createMemoryStorage(
      { [`${TRASH_PATH}/docs/a.txt/1000000`]: "hello a" },
      { nullMtimePaths: [`${TRASH_PATH}/docs/a.txt/1000000`] },
    );
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    const restored = await trash.restore("docs/a.txt/1000000");

    expect(restored.modifiedAt).toEqual(new Date(0));
  });

  it("removes the now-empty <name> directory after restoring the only version", async () => {
    const storage = createMemoryStorage({ [`${TRASH_PATH}/docs/a.txt/1000000`]: "hello a" });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    await trash.restore("docs/a.txt/1000000");

    expect(storage.dirs()).not.toContain(`${TRASH_PATH}/docs/a.txt`);
  });

  it("keeps the <name> directory when a sibling version is still trashed", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/docs/a.txt/1000000`]: "version one",
      [`${TRASH_PATH}/docs/a.txt/2000000`]: "version two",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    await trash.restore("docs/a.txt/1000000");

    expect(storage.dirs()).toContain(`${TRASH_PATH}/docs/a.txt`);
    const remaining = await trash.list();
    expect(remaining.entries.map((entry) => entry.id)).toEqual(["docs/a.txt/2000000"]);
  });

  it("throws bad_request for an id that does not parse", async () => {
    const storage = createMemoryStorage();
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    await expect(trash.restore("not-a-leaf")).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("propagates a conflict from the underlying move when the target already exists", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/docs/a.txt/1000000`]: "trashed",
      "/docs/a.txt": "already here",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    await expect(trash.restore("docs/a.txt/1000000")).rejects.toSatisfy(
      (error: unknown) => isStorageError(error) && error.kind === "conflict",
    );
  });
});

describe("createRecycleFolderTrash: purge", () => {
  it("permanently deletes the given leaves", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/docs/a.txt/1000000`]: "hello a",
      [`${TRASH_PATH}/top.txt/2000000`]: "top",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    await trash.purge(["docs/a.txt/1000000"]);

    const listing = await trash.list();
    expect(listing.entries.map((entry) => entry.id)).toEqual(["top.txt/2000000"]);
  });

  it("ignores ids that are already gone", async () => {
    const storage = createMemoryStorage({ [`${TRASH_PATH}/top.txt/1000000`]: "top" });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    await expect(trash.purge(["docs/missing.txt/9999999"])).resolves.toBeUndefined();
  });

  it("removes the now-empty <name> directory", async () => {
    const storage = createMemoryStorage({ [`${TRASH_PATH}/docs/a.txt/1000000`]: "hello a" });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    await trash.purge(["docs/a.txt/1000000"]);

    expect(storage.dirs()).not.toContain(`${TRASH_PATH}/docs/a.txt`);
  });

  it("propagates a deleteFile failure that is not a not_found StorageError", async () => {
    const storage = createMemoryStorage({ [`${TRASH_PATH}/docs/a.txt/1000000`]: "hello a" });
    storage.deleteFile = async () => {
      throw new Error("disk on fire");
    };
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    await expect(trash.purge(["docs/a.txt/1000000"])).rejects.toThrow("disk on fire");
  });
});

describe("createRecycleFolderTrash: empty", () => {
  it("deletes every child of the trash root but never the root itself, including a stray file directly at the root", async () => {
    const storage = createMemoryStorage({
      [`${TRASH_PATH}/docs/a.txt/1000000`]: "hello a",
      [`${TRASH_PATH}/top.txt/2000000`]: "top",
      [`${TRASH_PATH}/orphan.txt`]: "not a leaf, just a stray file at the trash root",
    });
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    await trash.empty();

    expect(await storage.list(TRASH_PATH)).toEqual([]);
    const listing = await trash.list();
    expect(listing.entries).toEqual([]);
  });

  it("is a no-op on an already-empty trash", async () => {
    const storage = createMemoryStorage();
    await storage.mkdir(TRASH_PATH);
    const trash = createRecycleFolderTrash({ storage, trashPath: TRASH_PATH });

    await expect(trash.empty()).resolves.toBeUndefined();
  });
});

it("refuses to restore into the trash folder itself or below it", async () => {
  const storage = createMemoryStorage({ "/.trash/docs/a.txt/1700000000000000000": "a" });
  const trash = createRecycleFolderTrash({ storage, trashPath: "/.trash" });
  for (const target of ["/.trash", "/.trash/docs/a.txt", "/.trash/elsewhere.txt"]) {
    await expect(trash.restore("docs/a.txt/1700000000000000000", { target })).rejects.toMatchObject(
      { kind: "bad_request" },
    );
  }
  expect(await storage.statFile("/.trash/docs/a.txt/1700000000000000000")).toMatchObject({
    size: 1,
  });
});
