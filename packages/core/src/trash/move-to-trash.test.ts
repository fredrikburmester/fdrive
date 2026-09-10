import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../../test/fixtures/memory-storage.ts";
import { withMoveToTrash } from "./move-to-trash.ts";
import { createRecycleFolderTrash } from "./recycle-folder-trash.ts";

const AT = new Date("2026-09-10T12:00:00.000Z");
const LEAF = (BigInt(AT.getTime()) * BigInt(1_000_000)).toString();

describe("withMoveToTrash", () => {
  it("moves a deleted file into the recycle folder layout the trash lists back", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "hello" });
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });
    await wrapped.deleteFile("/docs/a.txt");
    expect(storage.dump()).toEqual({ [`/.trash/docs/a.txt/${LEAF}`]: "hello" });

    const trash = createRecycleFolderTrash({ storage: wrapped, trashPath: "/.trash" });
    const listing = await trash.list();
    expect(listing.entries.map((entry) => entry.originalPath)).toEqual(["/docs/a.txt"]);
    await trash.restore(`docs/a.txt/${LEAF}`);
    expect(storage.dump()).toEqual({ "/docs/a.txt": "hello" });
  });

  it("moves a deleted directory with its contents and a root-level file", async () => {
    const storage = createMemoryStorage({ "/docs/sub/b.txt": "b", "/top.txt": "t" });
    const wrapped = withMoveToTrash({ storage, trashPath: "/.trash", clock: () => AT });
    await wrapped.deleteDir("/docs");
    await wrapped.deleteFile("/top.txt");
    expect(storage.dump()).toEqual({
      [`/.trash/docs/${LEAF}/sub/b.txt`]: "b",
      [`/.trash/top.txt/${LEAF}`]: "t",
    });
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
