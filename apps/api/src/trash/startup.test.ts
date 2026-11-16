import { StorageError } from "@fdrive/core";
import { createMemoryStorage, type MemoryStorage } from "@fdrive/core/testing";
import { describe, expect, it, vi } from "vitest";
import { memoryAccessRepo, testAccessFollowers } from "../../test/file-operations.js";
import { type MemoryTrashItemRepo, memoryTrashItemRepo } from "../../test/trash-items.js";
import { createTrashItems } from "./items.js";
import { settleTrashAtStart } from "./startup.js";

const ALICE = "00000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-11-15T12:00:00.000Z");

/** One start of the API over the same disk and database. */
function start(storage: MemoryStorage, repo: MemoryTrashItemRepo) {
  const links = { movePrefix: vi.fn(), deletePrefix: vi.fn() };
  const items = createTrashItems({
    repo,
    access: testAccessFollowers(memoryAccessRepo({ trash: repo, shares: links })),
    homeOf: async () => storage,
  });
  const eventLog = { record: vi.fn() };
  return { run: settleTrashAtStart({ items, repo, eventLog }), links, eventLog };
}

/** A row an interrupted delete of `/<name>` left, its item not yet arrived. */
const pending = (repo: MemoryTrashItemRepo, name: string) =>
  repo.begin({
    identityId: ALICE,
    originalPath: `/${name}`,
    name,
    kind: "file",
    size: 1,
    deletedAt: NOW,
    movingFrom: `/${name}`,
  });

describe("settleTrashAtStart", () => {
  it("settles what an interrupted delete left on its way into Trash", async () => {
    const storage = createMemoryStorage({ "/kept.txt": "kept" });
    const repo = memoryTrashItemRepo();
    const moved = await pending(repo, "moved.txt");
    await storage.upload(`/.trash/${moved.id}/moved.txt`, new TextEncoder().encode("m"), {
      mkdirParents: true,
    });
    const stayed = await pending(repo, "kept.txt");
    await storage.mkdir(`/.trash/${stayed.id}`, { parents: true });

    const started = start(storage, repo);
    await started.run;
    expect((await repo.list(ALICE, 10)).items).toMatchObject([
      { id: moved.id, originalPath: "/moved.txt", deletedAt: NOW },
    ]);
    expect(started.links.movePrefix).toHaveBeenCalledWith(
      ALICE,
      "/moved.txt",
      `/.trash/${moved.id}/moved.txt`,
      false,
    );
    expect(storage.dump()).toEqual({
      "/kept.txt": "kept",
      [`/.trash/${moved.id}/moved.txt`]: "m",
    });
    expect(storage.dirs()).not.toContain(`/.trash/${stayed.id}`);
    expect(await repo.pending()).toEqual([]);
    expect(started.eventLog.record).not.toHaveBeenCalled();
  });

  it("leaves an item it cannot settle for the next start, and settles the rest", async () => {
    const storage = createMemoryStorage();
    const repo = memoryTrashItemRepo();
    const unsure = await pending(repo, "unsure.txt");
    const moved = await pending(repo, "moved.txt");
    for (const item of [unsure, moved])
      await storage.upload(`/.trash/${item.id}/${item.name}`, new TextEncoder().encode("x"), {
        mkdirParents: true,
      });
    const stat = storage.stat.bind(storage);
    storage.stat = async (path) => {
      if (path.includes(unsure.id)) throw new StorageError("upstream_unavailable", "disk asleep");
      return stat(path);
    };

    const started = start(storage, repo);
    await started.run;
    expect(started.eventLog.record).toHaveBeenCalledWith(
      "general",
      "warn",
      "An item on its way into Trash waits for the next start",
      { identityId: ALICE, id: unsure.id, error: "disk asleep" },
    );
    expect((await repo.pending()).map((item) => item.id)).toEqual([unsure.id]);
    expect(await repo.get(ALICE, moved.id)).not.toBeNull();

    storage.stat = stat;
    await start(storage, repo).run;
    expect(await repo.pending()).toEqual([]);
    expect(await repo.get(ALICE, unsure.id)).not.toBeNull();
  });
});
