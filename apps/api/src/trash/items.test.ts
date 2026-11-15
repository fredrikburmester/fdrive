import { StorageError, trashItemPath } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { describe, expect, it, vi } from "vitest";
import { memoryAccessRepo, testAccessFollowers } from "../../test/file-operations.js";
import { recordingGateOnPool } from "../../test/recording-gate.js";
import { memoryTrashItemRepo } from "../../test/trash-items.js";
import { gated, type WriteGate } from "../backups/write-gate.js";
import { createTrashItems } from "./items.js";

const ALICE = "00000000-0000-4000-8000-0000000000a1";
const AT = new Date("2026-10-01T12:00:00.000Z");

function setup(files: Record<string, string> = {}, gate?: WriteGate) {
  const storage = createMemoryStorage(files);
  const repo = memoryTrashItemRepo();
  const links = { movePrefix: vi.fn(async () => {}), deletePrefix: vi.fn(async () => {}) };
  const accessRepo = memoryAccessRepo({ trash: repo, shares: links });
  const metadata = { onMoved: vi.fn(async () => {}) };
  const logger = { warn: vi.fn() };
  const items = createTrashItems({
    repo,
    access: testAccessFollowers(accessRepo),
    homeOf: async () => storage,
    metadata,
    logger,
    ...(gate === undefined ? {} : { gate }),
  });
  return { storage, repo, accessRepo, links, metadata, logger, items };
}

const pendingFrom = (movingFrom: string, name: string) => ({
  identityId: ALICE,
  originalPath: movingFrom,
  name,
  kind: "file" as const,
  size: 1,
  deletedAt: AT,
  movingFrom,
});

describe("TrashItems.settle", () => {
  it("lets an item that reached Trash arrive, with what was kept where it came from", async () => {
    const h = setup();
    const item = await h.repo.begin(pendingFrom("/docs/a.txt", "a.txt"));
    const leaf = trashItemPath(item.id, "a.txt");
    await h.storage.upload(leaf, new TextEncoder().encode("a"), { mkdirParents: true });

    await h.items.settle(item);
    expect(await h.items.get(ALICE, item.id)).toMatchObject({ originalPath: "/docs/a.txt" });
    expect(h.metadata.onMoved).toHaveBeenCalledWith(ALICE, "/docs/a.txt", leaf, false);
    expect(h.links.movePrefix).toHaveBeenCalledWith(ALICE, "/docs/a.txt", leaf, false);
    // Holding where it came from while it follows.
    expect(h.accessRepo.locks.at(-1)).toContainEqual({
      identityId: ALICE,
      path: "/docs/a.txt",
      exclusive: true,
    });

    // Settled once, it is never followed again.
    await h.items.settle(item);
    expect(h.metadata.onMoved).toHaveBeenCalledTimes(1);
  });

  it("forgets an item that never moved, and the folder made for it", async () => {
    const h = setup({ "/docs/a.txt": "a" });
    const item = await h.repo.begin(pendingFrom("/docs/a.txt", "a.txt"));
    await h.storage.mkdir(`/.trash/${item.id}`, { parents: true });

    await h.items.settle(item);
    expect(h.repo.rows.size).toBe(0);
    expect(h.storage.dirs()).not.toContain(`/.trash/${item.id}`);
    expect(h.storage.dump()).toEqual({ "/docs/a.txt": "a" });
    expect(h.metadata.onMoved).not.toHaveBeenCalled();
  });

  it("keeps the row when disk cannot tell, for the next start", async () => {
    const h = setup();
    const item = await h.repo.begin(pendingFrom("/a.txt", "a.txt"));
    h.storage.stat = async () => {
      throw new StorageError("upstream_unavailable", "not this installation's folder");
    };
    await expect(h.items.settle(item)).rejects.toMatchObject({ kind: "upstream_unavailable" });
    expect(await h.repo.pending()).toHaveLength(1);
  });

  it("lets an item arrive although its tags could not follow, and says so", async () => {
    const h = setup();
    const item = await h.repo.begin(pendingFrom("/a.txt", "a.txt"));
    await h.storage.upload(trashItemPath(item.id, "a.txt"), new TextEncoder().encode("a"), {
      mkdirParents: true,
    });
    h.metadata.onMoved.mockRejectedValueOnce(new Error("tags are down"));
    await h.items.settle(item);
    expect(await h.items.get(ALICE, item.id)).not.toBeNull();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("TrashItems and the backups' write gate", () => {
  it("settles on its own, as at start, inside one hold of the gate", async () => {
    const steps: string[] = [];
    const { gate, connections } = recordingGateOnPool(steps);
    const h = setup({}, gate);
    const item = await h.repo.begin(pendingFrom("/a.txt", "a.txt"));
    await h.storage.upload(trashItemPath(item.id, "a.txt"), new TextEncoder().encode("a"), {
      mkdirParents: true,
    });
    h.metadata.onMoved.mockImplementation(async () => {
      steps.push("followed");
    });
    await h.items.settle(item);
    expect(steps).toEqual(["gate held", "followed", "gate let go"]);
    expect(connections()).toBe(1);
    expect(await h.items.get(ALICE, item.id)).not.toBeNull();
  });

  it("settles inside the write it runs in, taking no second connection", async () => {
    const steps: string[] = [];
    const { gate, connections } = recordingGateOnPool(steps);
    const h = setup({}, gate);
    const item = await h.repo.begin(pendingFrom("/a.txt", "a.txt"));
    await gated(gate, () => h.items.settle(item));
    expect(steps).toEqual(["gate held", "gate let go"]);
    expect(connections()).toBe(1);
    expect(h.repo.rows.size).toBe(0);
  });
});
