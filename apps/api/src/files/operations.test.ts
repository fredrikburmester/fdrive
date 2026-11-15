import { type StorageProvider, trashItemPath } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { activityFixture } from "../../test/activity-fixture.js";
import {
  memoryAccessRepo,
  testAccessFollowers,
  testFileOperations,
} from "../../test/file-operations.js";
import { type MemoryTrashItemRepo, memoryTrashItemRepo } from "../../test/trash-items.js";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { createMetadataService } from "../metadata/service.js";
import type { AccessFollow, AccessFollowers, TouchedPaths } from "./access.js";
import { type FileActor, fileActor, moveMany, trashMany } from "./operations.js";

const ALICE = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const CLOCK = () => new Date("2026-11-15T00:00:00.000Z");

function principal(storage: StorageProvider): Principal {
  return { accountId: ACCOUNT, identityId: ALICE, username: "alice", storage, isAdmin: false };
}

/**
 * Access followers that note each step in `steps`, and fail `moved` or
 * `removed` when asked to, as a database that refuses the statement does.
 * Trash's rows change in `trash` as a transaction would change them: only
 * once `work` succeeded.
 */
function recordingAccess(
  steps: string[],
  fail: { moved?: Error; removed?: Error } = {},
  trash: MemoryTrashItemRepo = memoryTrashItemRepo(),
) {
  const follow = {
    moved: vi.fn(async (identityId: string, from: string, to: string, directory: boolean) => {
      steps.push(
        `access moved ${identityId === ALICE ? "alice" : identityId} ${from} -> ${to} ${directory}`,
      );
      if (fail.moved) throw fail.moved;
    }),
    removed: vi.fn(async (_identityId: string, path: string, directory: boolean) => {
      steps.push(`access removed ${path} ${directory}`);
      if (fail.removed) throw fail.removed;
    }),
  };
  const run = vi.fn(
    async (
      _identityId: string,
      _paths: TouchedPaths,
      work: (step: AccessFollow) => Promise<unknown>,
    ) => {
      const transaction = trash.transaction();
      const value = await work({
        ...follow,
        trash: {
          async entered(id, leaf) {
            steps.push(`trash entered ${id}`);
            return transaction.changes.entered(id, leaf);
          },
          async left(id) {
            steps.push(`trash left ${id}`);
            await transaction.changes.left(id);
          },
        },
      });
      transaction.commit();
      return value;
    },
  );
  const access: AccessFollowers = {
    run: run as AccessFollowers["run"],
    moved: follow.moved,
    removed: follow.removed,
  };
  return { access, follow, run };
}

/** Memory storage whose writes are noted in `steps`. */
function tracedStorage(files: Record<string, string>, steps: string[]) {
  const storage = createMemoryStorage(files);
  const move = storage.move.bind(storage);
  vi.spyOn(storage, "move").mockImplementation(async (from, to, options) => {
    steps.push(`storage move ${from} -> ${to}`);
    return move(from, to, options);
  });
  return storage;
}

function harness(
  files: Record<string, string>,
  fail: { moved?: Error; removed?: Error } = {},
  homeOf?: (identityId: string) => Promise<StorageProvider>,
) {
  const steps: string[] = [];
  const storage = tracedStorage(files, steps);
  const trash = memoryTrashItemRepo();
  const activity = activityFixture(CLOCK);
  const metadata = createMetadataService(createMemoryRepos());
  vi.spyOn(metadata, "onMoved").mockImplementation(async (_id, from, to) => {
    steps.push(`metadata moved ${from} -> ${to}`);
  });
  vi.spyOn(metadata, "onDeleted").mockImplementation(async (_id, path) => {
    steps.push(`metadata deleted ${path}`);
  });
  const { access, follow, run } = recordingAccess(steps, fail, trash);
  const logger = { warn: vi.fn() };
  const files_ = testFileOperations({
    activity: activity.service,
    access,
    metadata,
    logger,
    clock: CLOCK,
    trashRepo: trash,
    homeOf: homeOf ?? (async () => storage),
  });
  const actor: FileActor = fileActor(principal(storage), { source: "web" });
  /** The one item Alice's Trash lists. */
  const listed = async () => {
    const { items } = await trash.list(ALICE, 10);
    expect(items).toHaveLength(1);
    return items[0] as NonNullable<(typeof items)[0]>;
  };
  return {
    steps,
    storage,
    activity,
    metadata,
    follow,
    run,
    files: files_,
    actor,
    logger,
    trash,
    listed,
  };
}

describe("moving fails closed", () => {
  it("changes what grants access before the storage call, then lets the rest follow", async () => {
    const h = harness({ "/Projects/a.txt": "a" });
    const moved = await h.files.move(h.actor, "/Projects", "/Work");
    expect(moved).toMatchObject({
      entry: { path: "/Work", kind: "dir" },
      history: { pending: false },
    });
    expect(h.steps).toEqual([
      "access moved alice /Projects -> /Work true",
      "storage move /Projects -> /Work",
      "metadata moved /Projects -> /Work",
    ]);
    expect(h.run).toHaveBeenCalledWith(
      ALICE,
      { vacates: ["/Projects"], creates: ["/Work"] },
      expect.any(Function),
    );
    expect(h.activity.outcomes.at(-1)).toMatchObject({
      action: "file.move",
      outcome: "success",
      after: { path: "/Work", kind: "dir" },
    });
  });

  it("leaves the file where it was and fails when what grants access cannot follow", async () => {
    const h = harness({ "/Projects/a.txt": "a" }, { moved: new Error("database refused") });
    await expect(h.files.move(h.actor, "/Projects", "/Work")).rejects.toThrow("database refused");
    expect(h.steps).toEqual(["access moved alice /Projects -> /Work true"]);
    expect(h.storage.dump()).toEqual({ "/Projects/a.txt": "a" });
    expect(h.activity.outcomes.at(-1)).toMatchObject({ action: "file.move", outcome: "unknown" });
  });

  it("keeps a completed move whose tags could not follow, with a warning", async () => {
    const h = harness({ "/a.txt": "a" });
    vi.mocked(h.metadata.onMoved).mockRejectedValueOnce(new Error("tags offline"));
    const renamed = await h.files.move(h.actor, "/a.txt", "/b.txt", { action: "file.rename" });
    expect(renamed.warning).toBe(
      "Renamed, but its tags, favorite or recent entry could not follow it.",
    );
    expect(h.storage.dump()).toEqual({ "/b.txt": "a" });
  });

  it("refuses a move into its own descendant and does nothing for one onto itself", async () => {
    const h = harness({ "/a/b.txt": "b" });
    await expect(h.files.move(h.actor, "/a", "/a/inner")).rejects.toMatchObject({
      kind: "bad_request",
    });
    await h.files.move(h.actor, "/a", "/a");
    expect(h.steps).toEqual([]);
  });

  it("creates the missing parent folders of a move only once the source was found", async () => {
    const h = harness({ "/a.txt": "a" });
    await h.files.move(h.actor, "/a.txt", "/new/deep/a.txt", { createParents: true });
    await expect(
      h.files.move(h.actor, "/missing.txt", "/other/missing.txt", { createParents: true }),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(h.storage.dump()).toEqual({ "/new/deep/a.txt": "a" });
    await expect(h.storage.stat("/other")).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("Trash fails closed", () => {
  it("moves what grants access to the item's place in Trash, keeps its row, then moves it there", async () => {
    const h = harness({ "/a.txt": "a" });
    const { item } = await h.files.trash(h.actor, "/a.txt");
    const row = await h.listed();
    expect(row).toEqual({
      id: expect.any(String),
      identityId: ALICE,
      originalPath: "/a.txt",
      name: "a.txt",
      kind: "file",
      size: 1,
      deletedAt: CLOCK(),
    });
    expect(item).toEqual({ leaf: trashItemPath(row.id, "a.txt"), kind: "file" });
    expect(h.steps).toEqual([
      `access moved alice /a.txt -> ${item.leaf} false`,
      `trash entered ${row.id}`,
      `storage move /a.txt -> ${item.leaf}`,
      `metadata moved /a.txt -> ${item.leaf}`,
    ]);
    expect(h.run).toHaveBeenCalledWith(ALICE, { vacates: ["/a.txt"] }, expect.any(Function));
    expect(h.storage.dump()).toEqual({ [item.leaf]: "a" });
    expect(h.activity.outcomes.at(-1)).toMatchObject({
      action: "file.trash",
      after: { path: "/a.txt", kind: "file", trashLeaf: item.leaf },
    });
  });

  it("keeps a folder's row with no size of its own", async () => {
    const h = harness({ "/dir/a.txt": "abc" });
    await h.files.trash(h.actor, "/dir");
    expect(await h.listed()).toMatchObject({ originalPath: "/dir", kind: "dir", size: 0 });
  });

  it("leaves the file where it was, and nothing in Trash, when what grants access cannot follow it there", async () => {
    const h = harness({ "/a.txt": "a" }, { moved: new Error("database refused") });
    await expect(h.files.trash(h.actor, "/a.txt")).rejects.toThrow("database refused");
    expect(h.storage.dump()).toEqual({ "/a.txt": "a" });
    expect(h.steps).toEqual([
      expect.stringMatching(
        /^access moved alice \/a\.txt -> \/\.trash\/[0-9a-f-]{36}\/a\.txt false$/,
      ),
    ]);
    // The row written before it moved is settled away: the item never went.
    expect(h.trash.rows.size).toBe(0);
    expect(h.storage.dirs().filter((dir) => dir.startsWith("/.trash"))).toEqual([]);
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.activity.outcomes.at(-1)).toMatchObject({ action: "file.trash", outcome: "unknown" });
  });

  it("refuses what is not there before writing any row", async () => {
    const h = harness({});
    await expect(h.files.trash(h.actor, "/missing.txt")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(h.trash.rows.size).toBe(0);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("keeps a row on its way, out of the listing, when even settling a failed delete fails", async () => {
    const h = harness({ "/a.txt": "a" }, { moved: new Error("database refused") }, async () => {
      throw new Error("files folder offline");
    });
    await expect(h.files.trash(h.actor, "/a.txt")).rejects.toThrow("database refused");
    expect(h.storage.dump()).toEqual({ "/a.txt": "a" });
    expect((await h.trash.pending()).map((item) => item.movingFrom)).toEqual(["/a.txt"]);
    expect((await h.trash.list(ALICE, 10)).items).toEqual([]);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/a.txt" }),
      expect.stringContaining("next start"),
    );
  });

  it("lets an item that reached Trash arrive although its transaction failed after the rename", async () => {
    const h = harness({ "/a.txt": "a" });
    const run = h.run.getMockImplementation();
    // The commit after the rename fails once; settling it runs a transaction of its own.
    h.run.mockImplementationOnce(async (identityId, paths, work) => {
      await run?.(identityId, paths, work);
      throw new Error("connection lost at commit");
    });
    await expect(h.files.trash(h.actor, "/a.txt")).rejects.toThrow("connection lost at commit");
    const row = await h.listed();
    expect(h.storage.dump()).toEqual({ [trashItemPath(row.id, "a.txt")]: "a" });
    expect(await h.trash.pending()).toEqual([]);
  });

  it("puts an item in a folder shared with the login in its owner's Trash, with the owner's row and records", async () => {
    const steps: string[] = [];
    const storage = createMemoryStorage({ "/Shared with me/Team/a.txt": "a" });
    vi.spyOn(storage.trash, "put").mockImplementation(async (_path, id) => ({
      leaf: trashItemPath(id, "a.txt"),
      kind: "file",
    }));
    const metadata = createMetadataService(createMemoryRepos());
    const onMoved = vi.spyOn(metadata, "onMoved");
    const onDeleted = vi.spyOn(metadata, "onDeleted");
    const trash = memoryTrashItemRepo();
    const { access, follow } = recordingAccess(steps, {}, trash);
    const ownerPath = vi.fn(async () => ({ identityId: "owner", path: "/Team/a.txt" }));
    const files = testFileOperations({ access, metadata, ownerPath, trashRepo: trash });

    await files.trash(
      fileActor(principal(storage), { source: "web" }),
      "/Shared with me/Team/a.txt",
    );

    // The owner's Trash lists it, deleted from the owner's path; the person it is shared with has nothing.
    const [row] = (await trash.list("owner", 10)).items;
    expect(row).toMatchObject({ identityId: "owner", originalPath: "/Team/a.txt", name: "a.txt" });
    expect((await trash.list(ALICE, 10)).items).toEqual([]);
    const leaf = trashItemPath(row?.id ?? "", "a.txt");
    expect(storage.trash.put).toHaveBeenCalledWith("/Shared with me/Team/a.txt", row?.id);
    expect(follow.moved).toHaveBeenCalledWith("owner", "/Team/a.txt", leaf, false);
    expect(onMoved).toHaveBeenCalledWith("owner", "/Team/a.txt", leaf, false);
    expect(onDeleted).toHaveBeenCalledWith(ALICE, "/Shared with me/Team/a.txt", false);
  });
});

describe("restoring and purging fail closed", () => {
  it("brings what followed an item into Trash back before the item, and keeps nothing when the restore fails", async () => {
    const h = harness({ "/a.txt": "a" });
    const { item } = await h.files.trash(h.actor, "/a.txt");
    const { id } = await h.listed();
    h.steps.length = 0;
    await h.storage.upload("/a.txt", new Uint8Array([1]));
    await expect(h.files.restore(h.actor, id)).rejects.toMatchObject({ kind: "conflict" });
    // Still in Trash, its row kept.
    expect((await h.listed()).id).toBe(id);
    const { entry } = await h.files.restore(h.actor, id, "/b.txt");
    expect(entry).toMatchObject({ path: "/b.txt", kind: "file" });
    expect(h.steps).toEqual([
      `access moved alice ${item.leaf} -> /a.txt false`,
      `trash left ${id}`,
      `storage move ${item.leaf} -> /a.txt`,
      `access moved alice ${item.leaf} -> /b.txt false`,
      `trash left ${id}`,
      `storage move ${item.leaf} -> /b.txt`,
      `metadata moved ${item.leaf} -> /b.txt`,
    ]);
    expect((await h.trash.list(ALICE, 10)).items).toEqual([]);
    expect(h.activity.outcomes.map((row) => [row.action, row.outcome])).toEqual([
      ["file.trash", "success"],
      ["file.restore", "conflict"],
      ["file.restore", "success"],
    ]);
    expect(h.activity.operations.at(-1)).toMatchObject({
      action: "file.restore",
      requested: { path: "/a.txt", trashLeaf: item.leaf, targetPath: "/b.txt" },
    });
  });

  it("looks a restore up by its id and refuses one Trash does not hold, recording nothing", async () => {
    const h = harness({ "/a.txt": "a" });
    await h.files.trash(h.actor, "/a.txt");
    await expect(
      h.files.restore(h.actor, "7a4b2c1d-3e5f-4a6b-8c7d-9e0f1a2b3c4d"),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(h.activity.operations.map((row) => row.action)).toEqual(["file.trash"]);
  });

  it("ends what followed an item into Trash before deleting it, and deletes nothing when that fails", async () => {
    const failing = harness({ "/dir/a.txt": "a" }, { removed: new Error("database refused") });
    await failing.files.trash(failing.actor, "/dir");
    const { id } = await failing.listed();
    await expect(failing.files.purge(failing.actor, id)).rejects.toThrow("database refused");
    expect((await failing.listed()).id).toBe(id);
    expect(failing.storage.dump()).toEqual({ [`${trashItemPath(id, "dir")}/a.txt`]: "a" });

    const h = harness({ "/dir/a.txt": "a" });
    const trashed = await h.files.trash(h.actor, "/dir");
    const row = await h.listed();
    h.steps.length = 0;
    await h.files.purge(h.actor, row.id, { reason: "retention" });
    expect(h.steps).toEqual([
      `access removed ${trashed.item.leaf} true`,
      `trash left ${row.id}`,
      `metadata deleted ${trashed.item.leaf}`,
    ]);
    expect(h.storage.dump()).toEqual({});
    expect(h.storage.dirs().filter((dir) => dir.startsWith("/.trash/"))).toEqual([]);
    expect((await h.trash.list(ALICE, 10)).items).toEqual([]);
    expect(h.activity.operations.at(-1)).toMatchObject({
      action: "file.delete",
      requested: { path: "/dir", trashLeaf: trashed.item.leaf, reason: "retention" },
    });
  });

  it("is done with a purge of an item Trash does not hold, without history", async () => {
    const h = harness({});
    expect(await h.files.purge(h.actor, "7a4b2c1d-3e5f-4a6b-8c7d-9e0f1a2b3c4d")).toEqual({});
    expect(h.run).not.toHaveBeenCalled();
    expect(h.activity.operations).toEqual([]);
  });
});

describe("creating files", () => {
  it("records an upload and holds the path it creates, and records nothing for a link's visitor", async () => {
    const h = harness({});
    await h.files.upload(h.actor, "/new.txt", new Uint8Array([1, 2]), { action: "file.upload" });
    expect(h.run).toHaveBeenCalledWith(ALICE, { creates: ["/new.txt"] }, expect.any(Function));
    expect(h.activity.outcomes.at(-1)).toMatchObject({
      action: "file.upload",
      after: { path: "/new.txt", kind: "file", size: 2 },
    });
    const visitor: FileActor = { identityId: ALICE, storage: h.storage, recorded: null };
    await h.files.upload(visitor, "/visitor.txt", new Uint8Array([3]), { action: "file.upload" });
    expect(h.activity.operations).toHaveLength(1);
    expect(h.storage.dump()).toMatchObject({ "/visitor.txt": "\u0003" });
  });

  it("holds nothing while a body arrives, so other writes to the same path and others go on", async () => {
    const steps: string[] = [];
    const storage = createMemoryStorage({});
    let held = 0;
    const { access } = recordingAccess(steps);
    const run = access.run;
    const counted: AccessFollowers = {
      ...access,
      run: async (identityId, paths, work) => {
        held++;
        try {
          return await run(identityId, paths, work);
        } finally {
          held--;
        }
      },
    };
    const files = testFileOperations({ access: counted });
    const actor = fileActor(principal(storage), { source: "web" });
    let arrive!: () => void;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const stalled = new ReadableStream<Uint8Array>({
      async pull(controller) {
        reading();
        await new Promise<void>((resolve) => {
          arrive = resolve;
        });
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const slow = files.upload(actor, "/same.txt", stalled, {
      action: "file.save",
      overwrite: true,
    });
    await started;
    expect(held).toBe(0);
    await files.upload(actor, "/same.txt", new Uint8Array([2]), { action: "file.create" });
    await files.upload(actor, "/other.txt", new Uint8Array([3]), { action: "file.create" });
    await files.move(actor, "/other.txt", "/moved.txt");
    expect(storage.dump()).toEqual({ "/same.txt": "\u0002", "/moved.txt": "\u0003" });
    arrive();
    await slow;
    expect(storage.dump()).toEqual({ "/same.txt": "\u0001", "/moved.txt": "\u0003" });
  });

  it("only stores a piece before the last, which publishes nothing", async () => {
    const h = harness({});
    const uploadPart = vi.spyOn(h.storage, "uploadPart");
    const part = { id: "0123456789abcdef", offset: 0 };
    await h.files.uploadPart(h.actor, "/big.bin", new Uint8Array([1]), { part });
    expect(uploadPart).toHaveBeenCalledWith("/big.bin", expect.any(Uint8Array), { part });
    expect(h.storage.dump()).toEqual({});
    expect(h.run).not.toHaveBeenCalled();
    expect(h.activity.operations).toEqual([]);
  });

  it("reports the uploaded file from the upload itself, stat'ing only what was there before", async () => {
    const h = harness({ "/old.txt": "old" });
    const stat = vi.spyOn(h.storage, "stat");
    const { entry } = await h.files.upload(h.actor, "/old.txt", new Uint8Array([1, 2]), {
      action: "file.save",
      overwrite: true,
    });
    expect(entry).toMatchObject({ path: "/old.txt", kind: "file", size: 2 });
    expect(stat.mock.calls).toEqual([["/old.txt"]]);
  });

  it("creates folders and copies holding only what they create, with nothing following a copy", async () => {
    const h = harness({ "/a.txt": "a" });
    await h.files.mkdir(h.actor, "/folder");
    const copied = await h.files.copy(h.actor, "/a.txt", "/folder/a.txt", { variant: "duplicate" });
    await h.files.copy(h.actor, "/a.txt", "/a.txt");
    expect(copied.entry).toMatchObject({ path: "/folder/a.txt", kind: "file", size: 1 });
    expect(h.run.mock.calls.map(([, paths]) => paths)).toEqual([
      { creates: ["/folder"] },
      { creates: ["/folder/a.txt"] },
    ]);
    expect(h.steps).toEqual([]);
    expect(h.activity.operations.map((row) => [row.action, row.requested])).toEqual([
      ["folder.create", { path: "/folder", kind: "dir" }],
      ["file.copy", { path: "/a.txt", targetPath: "/folder/a.txt", variant: "duplicate" }],
      ["file.copy", { path: "/a.txt", targetPath: "/a.txt" }],
    ]);
  });
});

describe("moveMany and trashMany", () => {
  it("move what they can, report each item and its warning, and stop at anything unexpected", async () => {
    const h = harness({ "/a.txt": "a", "/b.txt": "b" });
    vi.mocked(h.metadata.onMoved).mockRejectedValueOnce(new Error("tags offline"));
    const results = await moveMany(
      h.files,
      principal(h.storage),
      {
        items: [
          { path: "/a.txt", target: "/c.txt" },
          { path: "/missing", target: "/d" },
        ],
      },
      { source: "ai", conversationId: "chat-1", producerOperationId: "op" },
    );
    expect(results).toEqual([
      {
        ok: true,
        path: "/a.txt",
        target: "/c.txt",
        warning: "Moved, but its tags, favorite or recent entry could not follow it.",
      },
      {
        ok: false,
        path: "/missing",
        target: "/d",
        error: { kind: "not_found", message: expect.any(String) },
      },
    ]);
    expect(h.activity.operations.map((row) => [row.producerOperationId, row.requested])).toEqual([
      ["op:0", { path: "/a.txt", targetPath: "/c.txt", conversationId: "chat-1" }],
      ["op:1", { path: "/missing", targetPath: "/d", conversationId: "chat-1" }],
    ]);
    const invalid = () => {
      throw new ApiHttpError("bad_request", "invalid path");
    };
    expect(
      await moveMany(
        h.files,
        principal(h.storage),
        { items: [{ path: "x", target: "y" }] },
        {
          source: "api",
        },
        "file.move",
        invalid,
      ),
    ).toEqual([
      {
        ok: false,
        path: "x",
        target: "y",
        error: { kind: "bad_request", message: "invalid path" },
      },
    ]);
    vi.spyOn(h.storage, "move").mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      moveMany(
        h.files,
        principal(h.storage),
        { items: [{ path: "/b.txt", target: "/e.txt" }] },
        {
          source: "api",
        },
      ),
    ).rejects.toThrow("socket hang up");
  });

  it("trash what they can and stop at anything unexpected", async () => {
    const h = harness({ "/a.txt": "a", "/dir/b.txt": "b" });
    const results = await trashMany(
      h.files,
      principal(h.storage),
      [{ path: "/a.txt" }, { path: "/missing.txt" }, { path: "/dir" }],
      { source: "ai" },
    );
    expect(results).toEqual([
      { path: "/a.txt", ok: true },
      {
        path: "/missing.txt",
        ok: false,
        error: { kind: "not_found", message: expect.any(String) },
      },
      { path: "/dir", ok: true },
    ]);
    const leaves = Object.fromEntries(
      (await h.trash.list(ALICE, 10)).items.map((item) => [
        item.name,
        trashItemPath(item.id, item.name),
      ]),
    );
    expect(h.storage.dump()).toEqual({
      [`${leaves.dir}/b.txt`]: "b",
      [`${leaves["a.txt"]}`]: "a",
    });
    vi.spyOn(h.storage.trash, "put").mockRejectedValueOnce(new Error("socket hang up"));
    await h.storage.upload("/c.txt", new Uint8Array([1]));
    await expect(
      trashMany(h.files, principal(h.storage), [{ path: "/c.txt" }], { source: "ai" }),
    ).rejects.toThrow("socket hang up");
  });
});

describe("without anything else wired", () => {
  it("works with no history and no metadata, links and shares following through the stores", async () => {
    const trashRepo = memoryTrashItemRepo();
    const repo = memoryAccessRepo({ trash: trashRepo });
    const files = testFileOperations({ access: testAccessFollowers(repo), trashRepo });
    const storage = createMemoryStorage({ "/a.txt": "a" });
    const actor = fileActor(principal(storage), { source: "api" });
    expect(await files.move(actor, "/a.txt", "/b.txt")).toEqual({
      entry: await storage.stat("/b.txt"),
    });
    const { item } = await files.trash(actor, "/b.txt");
    expect(item).toMatchObject({ kind: "file" });
    expect(repo.changes.map((change) => change.shares)).toEqual([
      { identityId: ALICE, from: "/a.txt", to: "/b.txt" },
      { identityId: ALICE, from: "/b.txt", to: item.leaf },
    ]);
    expect((await trashRepo.list(ALICE, 10)).items.map((row) => row.originalPath)).toEqual([
      "/b.txt",
    ]);
  });
});
