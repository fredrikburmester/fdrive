import { isWithin, StorageError, type StorageProvider, trashItemOf } from "@fdrive/core";
import { createMemoryStorage, type MemoryStorage } from "@fdrive/core/testing";
import type { AccessRepo, DesktopItemRecord, Identity } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { memoryAccessRepo, testAccessFollowers } from "../../test/file-operations.js";
import { type MemoryTrashItemRepo, memoryTrashItemRepo } from "../../test/trash-items.js";
import { createTrashItems } from "./items.js";
import { OLD_TRASH_ROOT } from "./old-layout.js";
import { settleTrashAtStart } from "./startup.js";

const ALICE = "00000000-0000-4000-8000-0000000000a1";
const BOB = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-11-15T12:00:00.000Z");
const stamp = (iso: string) => (BigInt(new Date(iso).getTime()) * 1_000_000n).toString();
const T1 = "2026-10-01T08:00:00.000Z";
const T2 = "2026-10-02T09:30:00.000Z";
const T3 = "2026-10-03T10:00:00.000Z";
const T4 = "2026-10-04T11:15:00.000Z";
const REPORT = "/docs/Å %20 50% ☀️.pdf";
const OLD = {
  report: `${OLD_TRASH_ROOT}/file/p/docs/p/Å %20 50% ☀️.pdf/v/${stamp(T1)}`,
  photos: `${OLD_TRASH_ROOT}/dir/p/Photos/p/2024 ☀️/v/${stamp(T2)}`,
  empty: `${OLD_TRASH_ROOT}/dir/p/empty/v/${stamp(T3)}`,
  reportAgain: `${OLD_TRASH_ROOT}/file/p/docs/p/Å %20 50% ☀️.pdf/v/${stamp(T4)}`,
  bobs: `${OLD_TRASH_ROOT}/file/p/b.txt/v/${stamp(T1)}`,
};
const MAC_OLD = `/.fdrive-desktop/${ALICE}/trash/handle`;

/** Everything one item holds, by its path in the item, as storage dumps it. */
type Contents = Record<string, string>;

/** A realistic old Trash, as a few weeks of deletes and restores left it. */
function oldTrash(): { alice: MemoryStorage; bob: MemoryStorage } {
  const alice = createMemoryStorage({
    [OLD.report]: "report",
    [`${OLD.photos}/a.jpg`]: "a",
    [`${OLD.photos}/deeper/c.jpg`]: "c",
    [OLD.reportAgain]: "report, again",
    // Not a leaf: loose in the old layout, never Trash's to move.
    [`${OLD_TRASH_ROOT}/file/p/stray.txt`]: "stray",
    [MAC_OLD]: "todo",
    "/docs/live.txt": "live",
  });
  const bob = createMemoryStorage({ [OLD.bobs]: "bob's" });
  return { alice, bob };
}

async function arrange(storages: { alice: MemoryStorage; bob: MemoryStorage }) {
  // An empty folder that went to Trash, and what a restore half done left behind.
  await storages.alice.mkdir(OLD.empty, { parents: true });
  await storages.alice.mkdir(`${OLD_TRASH_ROOT}/file/p/old/p/gone.txt/v`, { parents: true });
}

/** What every item in a Trash holds, as `[originalPath, deletedAt, contents]`. */
async function trashOf(
  storage: MemoryStorage,
  repo: MemoryTrashItemRepo,
  identityId: string,
): Promise<[string, string, Contents][]> {
  const { items } = await repo.list(identityId, 1000);
  const dump = storage.dump();
  return items
    .map((item): [string, string, Contents] => {
      const leaf = `/.trash/${item.id}/${item.name}`;
      const contents: Contents = {};
      for (const [path, body] of Object.entries(dump))
        if (isWithin(leaf, path)) contents[path.slice(leaf.length) || "."] = body;
      return [item.originalPath, item.deletedAt.toISOString(), contents];
    })
    .sort(([a, at], [b, bt]) => (a + at < b + bt ? -1 : 1));
}

const EXPECTED_ALICE: [string, string, Contents][] = [
  ["/Photos/2024 ☀️", T2, { "/a.jpg": "a", "/deeper/c.jpg": "c" }],
  [REPORT, T1, { ".": "report" }],
  [REPORT, T4, { ".": "report, again" }],
  ["/empty", T3, {}],
  ["/notes/todo.md", NOW.toISOString(), { ".": "todo" }],
];

/** Counts every step that changes disk or the database, and fails each one after `limit`. */
function crashAfter(limit: number) {
  let steps = 0;
  return {
    get steps() {
      return steps;
    },
    step() {
      steps += 1;
      if (steps > limit) throw new Error("crashed");
    },
  };
}
type Crash = ReturnType<typeof crashAfter>;

/** `target` with each of `names` counted as a step, which may crash. */
function crashing<T extends object>(target: T, crash: Crash, names: readonly (keyof T)[]): T {
  const wrapped = { ...target };
  for (const name of names) {
    const original = (target[name] as (...args: unknown[]) => Promise<unknown>).bind(target);
    (wrapped as Record<keyof T, unknown>)[name] = async (...args: unknown[]) => {
      crash.step();
      return original(...args);
    };
  }
  return wrapped;
}

/** One start of the API over the same disk and database. */
function start(
  storages: { alice: MemoryStorage; bob: MemoryStorage },
  repo: MemoryTrashItemRepo,
  handles: Map<string, Pick<DesktopItemRecord, "identityId" | "path" | "originalPath">>,
  crash: Crash = crashAfter(Number.POSITIVE_INFINITY),
) {
  const homes = {
    alice: crashing<StorageProvider>(storages.alice, crash, ["mkdir", "move", "deleteEmptyDir"]),
    bob: crashing<StorageProvider>(storages.bob, crash, ["mkdir", "move", "deleteEmptyDir"]),
  };
  const crashingRepo: MemoryTrashItemRepo = crashing(repo, crash, ["begin", "abandon"]);
  const links = { movePrefix: vi.fn(async () => crash.step()), deletePrefix: vi.fn() };
  const inner = memoryAccessRepo({ trash: repo, shares: links });
  // A crash before the transaction commits keeps none of it.
  const accessRepo: AccessRepo = {
    run: (locks, work) =>
      inner.run(locks, async (follow, trash) => {
        crash.step();
        const value = await work(follow, trash);
        crash.step();
        return value;
      }),
  };
  const metadata = {
    // The Mac's handles follow by path, as `withDesktopMetadata` moves them.
    onMoved: vi.fn(async (_identityId: string, from: string, to: string) => {
      crash.step();
      for (const [id, handle] of handles)
        if (isWithin(from, handle.path))
          handles.set(id, { ...handle, path: to + handle.path.slice(from.length) });
    }),
  };
  const homeOf = async (identityId: string) => (identityId === ALICE ? homes.alice : homes.bob);
  const items = createTrashItems({
    repo: crashingRepo,
    access: testAccessFollowers(accessRepo),
    homeOf,
    metadata,
  });
  const eventLog = { record: vi.fn() };
  const run = settleTrashAtStart({
    items,
    repo: crashingRepo,
    identities: {
      listAll: async () =>
        [ALICE, BOB].map((id) => ({ id, username: id === ALICE ? "alice" : "bob" }) as Identity),
    },
    homeOf,
    desktop: {
      oldTrash: async () =>
        [...handles]
          .filter(([, handle]) => handle.path.startsWith("/.fdrive-desktop/"))
          .map(
            ([id, handle]) => ({ id, ...handle }) as DesktopItemRecord & { originalPath: string },
          ),
      remove: async (_identityId, path) => {
        for (const [id, handle] of handles) if (handle.path === path) handles.delete(id);
      },
    },
    clock: () => NOW,
    eventLog,
  });
  return { run, metadata, links, eventLog };
}

describe("settleTrashAtStart", () => {
  it("moves a realistic old Trash into folders of its own, keeping each path and time", async () => {
    const storages = oldTrash();
    await arrange(storages);
    const repo = memoryTrashItemRepo();
    const handles = new Map([
      ["mac-handle", { identityId: ALICE, path: MAC_OLD, originalPath: "/notes/todo.md" }],
      [
        "mac-gone",
        { identityId: ALICE, path: `/.fdrive-desktop/${ALICE}/trash/gone`, originalPath: "/gone" },
      ],
      ["old-handle", { identityId: ALICE, path: OLD.report, originalPath: null }],
    ]);
    const started = start(storages, repo, handles);
    await started.run;

    expect(await trashOf(storages.alice, repo, ALICE)).toEqual(EXPECTED_ALICE);
    expect(await trashOf(storages.bob, repo, BOB)).toEqual([["/b.txt", T1, { ".": "bob's" }]]);
    // Only what was never Trash's stays in the old layout; nothing else is deleted.
    expect(
      Object.keys(storages.alice.dump())
        .filter((path) => !trashItemOf(path))
        .sort(),
    ).toEqual(["/.trash/.fdrive-move-v1/file/p/stray.txt", "/docs/live.txt"]);
    expect(storages.bob.dirs()).not.toContain(OLD_TRASH_ROOT);
    expect(await repo.pending()).toEqual([]);
    // What followed an item into its old place follows it to the new one, Mac handles too.
    const [report] = (await repo.list(ALICE, 10)).items.filter(
      (item) => item.deletedAt.toISOString() === T1,
    );
    const reportLeaf = `/.trash/${report?.id}/${report?.name}`;
    expect(handles.get("old-handle")?.path).toBe(reportLeaf);
    expect(started.links.movePrefix).toHaveBeenCalledWith(ALICE, OLD.report, reportLeaf, false);
    expect(handles.get("mac-handle")?.path).toMatch(/^\/\.trash\/[0-9a-f-]{36}\/todo\.md$/);
    // A Mac item gone from disk is forgotten.
    expect(handles.has("mac-gone")).toBe(false);
    expect(started.eventLog.record).toHaveBeenCalledWith(
      "general",
      "info",
      "Moved Trash's old layout into Trash",
      { moved: 5 },
    );

    // The next start finds nothing to do.
    const again = start(storages, repo, handles);
    await again.run;
    expect(again.metadata.onMoved).not.toHaveBeenCalled();
    expect(await trashOf(storages.alice, repo, ALICE)).toEqual(EXPECTED_ALICE);
  });

  it("settles what an interrupted delete left on its way into Trash", async () => {
    const storages = {
      alice: createMemoryStorage({ "/kept.txt": "kept" }),
      bob: createMemoryStorage(),
    };
    const repo = memoryTrashItemRepo();
    const pending = (name: string) =>
      repo.begin({
        identityId: ALICE,
        originalPath: `/${name}`,
        name,
        kind: "file",
        size: 1,
        deletedAt: NOW,
        movingFrom: `/${name}`,
      });
    const moved = await pending("moved.txt");
    await storages.alice.upload(`/.trash/${moved.id}/moved.txt`, new TextEncoder().encode("m"), {
      mkdirParents: true,
    });
    const stayed = await pending("kept.txt");
    await storages.alice.mkdir(`/.trash/${stayed.id}`, { parents: true });

    const started = start(storages, repo, new Map());
    await started.run;
    expect(await trashOf(storages.alice, repo, ALICE)).toEqual([
      ["/moved.txt", NOW.toISOString(), { ".": "m" }],
    ]);
    expect(started.links.movePrefix).toHaveBeenCalledWith(
      ALICE,
      "/moved.txt",
      `/.trash/${moved.id}/moved.txt`,
      false,
    );
    expect(storages.alice.dump()).toMatchObject({ "/kept.txt": "kept" });
    expect(storages.alice.dirs()).not.toContain(`/.trash/${stayed.id}`);
    expect(await repo.pending()).toEqual([]);
  });

  it("leaves what it cannot move where it is, for the next start", async () => {
    const storages = oldTrash();
    await arrange(storages);
    const repo = memoryTrashItemRepo();
    const move = storages.alice.move.bind(storages.alice);
    storages.alice.move = async (from, to, opts) => {
      if (from === OLD.report) throw new StorageError("forbidden", "a link on the way");
      return move(from, to, opts);
    };
    const started = start(storages, repo, new Map());
    await started.run;
    expect(storages.alice.dump()).toMatchObject({ [OLD.report]: "report" });
    expect(started.eventLog.record).toHaveBeenCalledWith(
      "general",
      "warn",
      "An item in Trash's old layout stays there",
      { identityId: ALICE, path: OLD.report, error: "a link on the way" },
    );
    expect((await trashOf(storages.alice, repo, ALICE)).map(([path, at]) => [path, at])).toEqual([
      ["/Photos/2024 ☀️", T2],
      [REPORT, T4],
      ["/empty", T3],
    ]);

    storages.alice.move = move;
    await start(storages, repo, new Map()).run;
    expect((await trashOf(storages.alice, repo, ALICE)).map(([path, at]) => [path, at])).toEqual(
      EXPECTED_ALICE.filter(([path]) => path !== "/notes/todo.md").map(([path, at]) => [path, at]),
    );
  });

  it("resumes a move interrupted at any step, losing and doubling nothing", async () => {
    const counted = oldTrash();
    await arrange(counted);
    const counter = crashAfter(Number.POSITIVE_INFINITY);
    const handles = () =>
      new Map([
        ["mac-handle", { identityId: ALICE, path: MAC_OLD, originalPath: "/notes/todo.md" }],
      ]);
    await start(counted, memoryTrashItemRepo(), handles(), counter).run;
    const steps = counter.steps;
    expect(steps).toBeGreaterThan(40);

    for (let limit = 0; limit < steps; limit += 1) {
      const storages = oldTrash();
      await arrange(storages);
      const repo = memoryTrashItemRepo();
      const macHandles = handles();
      // The process dies after `limit` steps: nothing after it happens.
      await start(storages, repo, macHandles, crashAfter(limit)).run.catch(() => undefined);
      // Every item is in its old place or its new one, never both and never neither.
      const halfway = storages.alice.dump();
      for (const [old, body] of [
        [OLD.report, "report"],
        [OLD.reportAgain, "report, again"],
        [MAC_OLD, "todo"],
      ] as const) {
        const copies = Object.entries(halfway).filter(([, held]) => held === body);
        expect(copies, `${old} after ${limit} steps`).toHaveLength(1);
      }

      await start(storages, repo, macHandles).run;
      expect(await trashOf(storages.alice, repo, ALICE), `crashed after ${limit} steps`).toEqual(
        EXPECTED_ALICE,
      );
      expect(await trashOf(storages.bob, repo, BOB)).toEqual([["/b.txt", T1, { ".": "bob's" }]]);
      expect(await repo.pending()).toEqual([]);
      expect(repo.rows.size).toBe(6);
      expect(macHandles.get("mac-handle")?.path).toMatch(/^\/\.trash\/[0-9a-f-]{36}\/todo\.md$/);
    }
  });
});
