import { StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { describe, expect, it } from "vitest";
import {
  OLD_TRASH_ROOT,
  oldTrashLeaves,
  parseOldTrashLeaf,
  removeEmptyOldFolders,
} from "./old-layout.js";

const AT = new Date("2026-10-01T12:00:00.000Z");
const STAMP = (BigInt(AT.getTime()) * 1_000_000n).toString();

describe("parseOldTrashLeaf", () => {
  it("reads the path and time an old leaf names, each segment as it was", () => {
    const path = `${OLD_TRASH_ROOT}/file/p/docs/p/Å %20 50%.pdf/v/${STAMP}`;
    expect(parseOldTrashLeaf(path)).toEqual({
      path,
      originalPath: "/docs/Å %20 50%.pdf",
      deletedAt: AT,
    });
    // `p` and `v` are names like any other inside the path.
    expect(parseOldTrashLeaf(`${OLD_TRASH_ROOT}/dir/p/p/p/v/v/1`)?.originalPath).toBe("/p/v");
  });

  it.each([
    OLD_TRASH_ROOT,
    "/.trash/elsewhere/file/p/a/v/1",
    `${OLD_TRASH_ROOT}/link/p/a/v/1`,
    `${OLD_TRASH_ROOT}/file/v/1`,
    `${OLD_TRASH_ROOT}/file/p/a`,
    `${OLD_TRASH_ROOT}/file/p/a/v`,
    `${OLD_TRASH_ROOT}/file/p/a/v/not-a-time`,
    `${OLD_TRASH_ROOT}/file/p/a/v/${"1".repeat(21)}`,
    `${OLD_TRASH_ROOT}/file/x/a/v/1`,
    `${OLD_TRASH_ROOT}/file/p/a/p/v/1`,
    `${OLD_TRASH_ROOT}/file/p/a/v/1/inside`,
  ])("is no leaf: %s", (path) => {
    expect(parseOldTrashLeaf(path)).toBeNull();
  });
});

describe("oldTrashLeaves", () => {
  it("finds every leaf, folders included, and nothing else", async () => {
    const storage = createMemoryStorage({
      [`${OLD_TRASH_ROOT}/file/p/a.txt/v/1`]: "a",
      [`${OLD_TRASH_ROOT}/dir/p/docs/p/2026/v/2/inside.txt`]: "inside",
      [`${OLD_TRASH_ROOT}/file/p/stray.txt`]: "not a leaf",
    });
    await storage.mkdir(`${OLD_TRASH_ROOT}/dir/p/empty/v/3`, { parents: true });
    const leaves = await oldTrashLeaves(storage);
    expect(leaves.map((leaf) => leaf.originalPath).sort()).toEqual([
      "/a.txt",
      "/docs/2026",
      "/empty",
    ]);
  });

  it("finds nothing where there is no old layout, and passes on other failures", async () => {
    expect(await oldTrashLeaves(createMemoryStorage())).toEqual([]);
    const failing = createMemoryStorage();
    failing.list = async () => {
      throw new StorageError("upstream_unavailable", "not this installation's folder");
    };
    await expect(oldTrashLeaves(failing)).rejects.toMatchObject({ kind: "upstream_unavailable" });
  });
});

describe("removeEmptyOldFolders", () => {
  it("removes empty folders deepest first, never a leaf or anything with something in it", async () => {
    const storage = createMemoryStorage({
      [`${OLD_TRASH_ROOT}/file/p/stray.txt`]: "kept",
      "/.trash/other.txt": "kept",
    });
    // What a restore left behind, and an empty folder that is an item.
    await storage.mkdir(`${OLD_TRASH_ROOT}/file/p/old/p/gone.txt/v`, { parents: true });
    await storage.mkdir(`${OLD_TRASH_ROOT}/dir/p/empty/v/3`, { parents: true });
    await removeEmptyOldFolders(storage);
    expect(storage.dirs().filter((dir) => dir.startsWith(OLD_TRASH_ROOT))).toEqual(
      expect.arrayContaining([`${OLD_TRASH_ROOT}/dir/p/empty/v/3`, `${OLD_TRASH_ROOT}/file/p`]),
    );
    expect(storage.dirs()).not.toContain(`${OLD_TRASH_ROOT}/file/p/old`);
    expect(storage.dump()).toEqual({
      [`${OLD_TRASH_ROOT}/file/p/stray.txt`]: "kept",
      "/.trash/other.txt": "kept",
    });
  });

  it("removes the old layout itself once it is empty", async () => {
    const storage = createMemoryStorage();
    await storage.mkdir(`${OLD_TRASH_ROOT}/file/p/a.txt/v`, { parents: true });
    await removeEmptyOldFolders(storage);
    expect(storage.dirs()).not.toContain(OLD_TRASH_ROOT);
    expect(storage.dirs()).toContain("/.trash");
  });
});
