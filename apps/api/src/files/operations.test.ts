import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { activityFixture } from "../../test/activity-fixture.js";
import {
  memoryAccessRepo,
  testAccessFollowers,
  testFileOperations,
} from "../../test/file-operations.js";
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
 */
function recordingAccess(steps: string[], fail: { moved?: Error; removed?: Error } = {}) {
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
    ) => work(follow),
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

function harness(files: Record<string, string>, fail: { moved?: Error; removed?: Error } = {}) {
  const steps: string[] = [];
  const storage = tracedStorage(files, steps);
  const activity = activityFixture(CLOCK);
  const metadata = createMetadataService(createMemoryRepos());
  vi.spyOn(metadata, "onMoved").mockImplementation(async (_id, from, to) => {
    steps.push(`metadata moved ${from} -> ${to}`);
  });
  vi.spyOn(metadata, "onDeleted").mockImplementation(async (_id, path) => {
    steps.push(`metadata deleted ${path}`);
  });
  const { access, follow, run } = recordingAccess(steps, fail);
  const logger = { error: vi.fn() };
  const files_ = testFileOperations({
    activity: activity.service,
    access,
    metadata,
    logger,
    storageFor: async () => storage,
  });
  const actor: FileActor = fileActor(principal(storage), { source: "web" });
  return { steps, storage, activity, metadata, follow, run, files: files_, actor, logger };
}

describe("moving fails closed", () => {
  it("changes what grants access before the storage call, then lets the rest follow", async () => {
    const h = harness({ "/Projects/a.txt": "a" });
    const moved = await h.files.move(h.actor, "/Projects", "/Work");
    expect(moved).toMatchObject({ kind: "dir", history: { pending: false } });
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
  it("moves what grants access to the leaf Trash names, then the rest", async () => {
    const h = harness({ "/a.txt": "a" });
    const { item } = await h.files.trash(h.actor, "/a.txt");
    expect(item).toEqual({ leaf: "/.trash/.fdrive-move-v1/file/p/a.txt/v/0", kind: "file" });
    expect(h.steps).toEqual([
      `storage move /a.txt -> ${item.leaf}`,
      `access moved alice /a.txt -> ${item.leaf} false`,
      `metadata moved /a.txt -> ${item.leaf}`,
    ]);
    expect(h.activity.outcomes.at(-1)).toMatchObject({
      action: "file.trash",
      after: { path: "/a.txt", kind: "file", trashLeaf: item.leaf },
    });
  });

  it("takes the item back out of Trash when what grants access cannot follow it there", async () => {
    const h = harness({ "/a.txt": "a" }, { moved: new Error("database refused") });
    await expect(h.files.trash(h.actor, "/a.txt")).rejects.toThrow("database refused");
    expect(h.storage.dump()).toEqual({ "/a.txt": "a" });
    expect(h.steps).not.toContain(expect.stringContaining("metadata"));
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("says so loudly when it cannot take the item back", async () => {
    const h = harness({ "/a.txt": "a" }, { moved: new Error("database refused") });
    vi.spyOn(h.storage.trash, "restore").mockRejectedValueOnce(
      new StorageError("conflict", "taken"),
    );
    await expect(h.files.trash(h.actor, "/a.txt")).rejects.toThrow("database refused");
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/a.txt" }),
      expect.stringContaining("could not follow it"),
    );
  });

  it("puts an item in a folder shared with the login in its owner's Trash, with the owner's records", async () => {
    const steps: string[] = [];
    const storage = createMemoryStorage({ "/Shared with me/Team/a.txt": "a" });
    vi.spyOn(storage.trash, "put").mockResolvedValue({
      leaf: "/.trash/.fdrive-move-v1/file/p/Team/p/a.txt/v/0",
      kind: "file",
    });
    const metadata = createMetadataService(createMemoryRepos());
    const onMoved = vi.spyOn(metadata, "onMoved");
    const onDeleted = vi.spyOn(metadata, "onDeleted");
    const { access, follow } = recordingAccess(steps);
    const ownerPath = vi.fn(async () => ({ identityId: "owner", path: "/Team/a.txt" }));
    const files = testFileOperations({ access, metadata, ownerPath });

    await files.trash(
      fileActor(principal(storage), { source: "web" }),
      "/Shared with me/Team/a.txt",
    );

    const leaf = "/.trash/.fdrive-move-v1/file/p/Team/p/a.txt/v/0";
    expect(follow.moved).toHaveBeenCalledWith("owner", "/Team/a.txt", leaf, false);
    expect(onMoved).toHaveBeenCalledWith("owner", "/Team/a.txt", leaf, false);
    expect(onDeleted).toHaveBeenCalledWith(ALICE, "/Shared with me/Team/a.txt", false);
  });
});

describe("restoring and purging fail closed", () => {
  it("brings what followed an item into Trash back before the item, and keeps nothing when the restore fails", async () => {
    const h = harness({ "/a.txt": "a" });
    const { item } = await h.files.trash(h.actor, "/a.txt");
    const id = item.leaf.slice("/.trash/".length);
    h.steps.length = 0;
    await h.storage.upload("/a.txt", new Uint8Array([1]));
    await expect(h.files.restore(h.actor, id)).rejects.toMatchObject({ kind: "conflict" });
    const { entry } = await h.files.restore(h.actor, id, "/b.txt");
    expect(entry).toMatchObject({ path: "/b.txt", kind: "file" });
    expect(h.steps).toEqual([
      `access moved alice ${item.leaf} -> /a.txt false`,
      `storage move ${item.leaf} -> /a.txt`,
      `access moved alice ${item.leaf} -> /b.txt false`,
      `storage move ${item.leaf} -> /b.txt`,
      `metadata moved ${item.leaf} -> /b.txt`,
    ]);
    expect(h.activity.outcomes.map((row) => [row.action, row.outcome])).toEqual([
      ["file.trash", "success"],
      ["file.restore", "conflict"],
      ["file.restore", "success"],
    ]);
  });

  it("ends what followed an item into Trash before deleting it, and deletes nothing when that fails", async () => {
    const failing = harness({ "/dir/a.txt": "a" }, { removed: new Error("database refused") });
    const { item } = await failing.files.trash(failing.actor, "/dir");
    const id = item.leaf.slice("/.trash/".length);
    await expect(failing.files.purge(failing.actor, id)).rejects.toThrow("database refused");
    expect((await failing.storage.trash.list()).entries.map((entry) => entry.id)).toEqual([id]);

    const h = harness({ "/dir/a.txt": "a" });
    const trashed = await h.files.trash(h.actor, "/dir");
    h.steps.length = 0;
    await h.files.purge(h.actor, trashed.item.leaf.slice("/.trash/".length), {
      reason: "retention",
    });
    expect(h.steps).toEqual([
      `access removed ${trashed.item.leaf} true`,
      `metadata deleted ${trashed.item.leaf}`,
    ]);
    expect(h.storage.dump()).toEqual({});
    expect(h.activity.operations.at(-1)).toMatchObject({
      action: "file.delete",
      requested: { path: "/dir", trashLeaf: trashed.item.leaf, reason: "retention" },
    });
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

  it("only stores a piece before the last, which publishes nothing", async () => {
    const h = harness({});
    const upload = vi.spyOn(h.storage, "upload").mockResolvedValue();
    const part = { id: "0123456789abcdef", offset: 0, final: false };
    expect(
      await h.files.upload(h.actor, "/big.bin", new Uint8Array([1]), {
        action: "file.upload",
        part,
      }),
    ).toEqual({});
    expect(upload).toHaveBeenCalledWith("/big.bin", expect.any(Uint8Array), { part });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.activity.operations).toEqual([]);
  });

  it("creates folders and copies holding only what they create, with nothing following a copy", async () => {
    const h = harness({ "/a.txt": "a" });
    await h.files.mkdir(h.actor, "/folder");
    const copied = await h.files.copy(h.actor, "/a.txt", "/folder/a.txt", { variant: "duplicate" });
    await h.files.copy(h.actor, "/a.txt", "/a.txt");
    expect(copied.kind).toBe("file");
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
    expect(h.storage.dump()).toEqual({
      "/.trash/.fdrive-move-v1/dir/p/dir/v/0/b.txt": "b",
      "/.trash/.fdrive-move-v1/file/p/a.txt/v/0": "a",
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
    const repo = memoryAccessRepo();
    const files = testFileOperations({ access: testAccessFollowers(repo) });
    const storage = createMemoryStorage({ "/a.txt": "a" });
    const actor = fileActor(principal(storage), { source: "api" });
    expect(await files.move(actor, "/a.txt", "/b.txt")).toEqual({ kind: "file" });
    expect(await files.trash(actor, "/b.txt")).toMatchObject({ item: { kind: "file" } });
    expect(repo.changes.map((change) => change.shares)).toEqual([
      { identityId: ALICE, from: "/a.txt", to: "/b.txt" },
      { identityId: ALICE, from: "/b.txt", to: "/.trash/.fdrive-move-v1/file/p/b.txt/v/0" },
    ]);
  });
});
