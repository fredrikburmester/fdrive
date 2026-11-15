import type { FsEvent } from "@fdrive/contracts";
import type { Scope } from "@fdrive/core";
import type { Change, ChangeSource, Identity } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { type BusEvent, createEventBus } from "./bus.js";
import {
  createJournalFanout,
  fsEventFor,
  JOURNAL_CONSUMER,
  type JournalFanoutDeps,
  type Login,
  type SeenChange,
  seenBy,
} from "./journal.js";

const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const AT = new Date("2026-11-15T10:00:00.000Z");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function row(
  position: number,
  path: string,
  targetPath: string | null = null,
  source: ChangeSource = "api",
): Change {
  return { position, path, targetPath, source, content: null, createdAt: AT };
}

const home = (username: string): Scope => ({ fsPrefix: `/${username}`, virtualPrefix: "/" });

/** alice owns `Project` and shares it with bob; carol shares nothing with anyone. */
const SCOPES: Record<string, Scope[]> = {
  alice: [home("alice")],
  bob: [home("bob"), { fsPrefix: "/alice/Project", virtualPrefix: "/Shared with me/Project" }],
  carol: [home("carol")],
};

const identity = (username: string): Identity => ({
  id: `id-${username}`,
  accountId: `account-${username}`,
  providerId: "provider",
  externalUsername: username,
  createdAt: AT,
  lastLoginAt: null,
});

function fakeJournal(rows: Change[]) {
  const state = { oldest: 1, saved: new Map<string, number>(), reads: 0, failReads: 0 };
  const journal: JournalFanoutDeps["journal"] = {
    async read(after, limit) {
      state.reads += 1;
      if (state.failReads > 0) {
        state.failReads -= 1;
        throw new Error("database gone");
      }
      return {
        gap: after < state.oldest - 1,
        changes: rows.filter((change) => change.position > after).slice(0, limit),
      };
    },
    end: async () => rows.at(-1)?.position ?? 0,
    epoch: async () => EPOCH,
    cursor: async (consumer) => state.saved.get(consumer) ?? null,
    async saveCursor(consumer, position) {
      state.saved.set(consumer, position);
    },
  };
  return { journal, state };
}

function harness(
  rows: Change[] = [],
  overrides: Partial<JournalFanoutDeps> & { cursor?: number } = {},
) {
  const { journal, state } = fakeJournal(rows);
  if (overrides.cursor !== undefined) state.saved.set(JOURNAL_CONSUMER, overrides.cursor);
  const bus = createEventBus();
  const published: BusEvent[] = [];
  for (const username of Object.keys(SCOPES))
    bus.subscribe({ identityId: `id-${username}` }, (event) => published.push(event));
  const outside = vi.fn(async (_login: Login, _seen: SeenChange) => undefined);
  const warnings: string[] = [];
  const fanout = createJournalFanout({
    journal,
    identities: { listAll: async () => Object.keys(SCOPES).map(identity) },
    scopes: async (username) => {
      const scopes = SCOPES[username];
      if (scopes === undefined) throw new Error("this login has no valid home folder");
      return scopes;
    },
    bus,
    outside,
    logger: { warn: (_data, message) => warnings.push(message) },
    ...overrides,
  });
  /** Who got which event, as `username: op path [-> target] @position`. */
  const seen = () =>
    published.map((event) =>
      event.type === "fs"
        ? `${event.identityId.slice(3)}: ${event.op} ${event.paths[0]}${event.targetPaths ? ` -> ${event.targetPaths[0]}` : ""} @${event.position}`
        : event.type,
    );
  return { fanout, journal, state, bus, published, seen, outside, warnings, rows };
}

describe("seenBy and fsEventFor", () => {
  it("maps each end through the scopes and drops a row no scope reaches", () => {
    const move = row(1, "alice/Project/a.txt", "alice/a.txt");
    const bob = seenBy(SCOPES.bob as Scope[], move);
    expect(bob).toMatchObject({ path: "/Shared with me/Project/a.txt", target: null });
    expect(fsEventFor(bob as SeenChange)).toEqual({
      type: "fs",
      op: "change",
      paths: ["/Shared with me/Project/a.txt"],
      at: AT.toISOString(),
    });
    const alice = seenBy(SCOPES.alice as Scope[], move) as SeenChange;
    expect(fsEventFor(alice)).toEqual({
      type: "fs",
      op: "move",
      paths: ["/Project/a.txt"],
      targetPaths: ["/a.txt"],
      at: AT.toISOString(),
    });
    expect(seenBy(SCOPES.carol as Scope[], move)).toBeNull();
    // Moved into someone's files from outside them: look at the target.
    const into = seenBy(SCOPES.bob as Scope[], row(2, "alice/b.txt", "alice/Project/b.txt"));
    expect(fsEventFor(into as SeenChange).paths).toEqual(["/Shared with me/Project/b.txt"]);
  });
});

describe("createJournalFanout", () => {
  it("starts at the journal's end without a saved position", async () => {
    const h = harness([row(1, "alice/old.txt")]);
    await h.fanout.start();
    await tick();
    expect(h.fanout.epoch()).toBe(EPOCH);
    expect(h.fanout.position()).toBe(1);
    expect(h.published).toEqual([]);
  });

  it("publishes one event per login that sees a change, the people it is shared with included", async () => {
    const h = harness([], { cursor: 0 });
    h.rows.push(row(1, "alice/Project/plan.md"), row(2, "alice/notes.txt"), row(3, "dave/x"));
    await h.fanout.start();
    await tick();
    expect(h.seen()).toEqual([
      "alice: change /Project/plan.md @1",
      "bob: change /Shared with me/Project/plan.md @1",
      "alice: change /notes.txt @2",
    ]);
    expect(h.fanout.position()).toBe(3);
    expect(h.state.saved.get(JOURNAL_CONSUMER)).toBe(3);
    expect(h.outside).not.toHaveBeenCalled();
  });

  it("brings metadata along only for changes fdrive did not make, before telling anyone", async () => {
    const h = harness([], { cursor: 0 });
    h.rows.push(
      row(1, "alice/Project", "alice/Plans", "watcher"),
      row(2, "alice/a.txt", "alice/b.txt", "api"),
      row(3, "alice/scan.pdf", null, "scan"),
    );
    const order: string[] = [];
    h.outside.mockImplementation(async (login) => {
      order.push(`outside ${login.username} ${h.published.length}`);
    });
    await h.fanout.start();
    await tick();
    expect(
      h.outside.mock.calls.map(([login, seen]) => [login.username, seen.path, seen.target]),
    ).toEqual([
      ["alice", "/Project", "/Plans"],
      ["bob", "/Shared with me/Project", null],
      ["alice", "/scan.pdf", null],
    ]);
    // Both logins' metadata moved before either heard of the move.
    expect(order).toEqual(["outside alice 0", "outside bob 0", "outside alice 3"]);
  });

  it("still publishes when metadata cannot follow, and says so", async () => {
    const h = harness([], { cursor: 0 });
    h.rows.push(row(1, "alice/gone.txt", null, "watcher"));
    h.outside.mockRejectedValue(new Error("tags are down"));
    await h.fanout.start();
    await tick();
    expect(h.seen()).toEqual(["alice: change /gone.txt @1"]);
    expect(h.warnings).toEqual(["journal: metadata did not follow a change made outside fdrive"]);
  });

  it("reads a page at a time, saving its position after each", async () => {
    const saved: number[] = [];
    const h = harness([], { cursor: 0, pageSize: 2 });
    const save = h.journal.saveCursor;
    h.journal.saveCursor = async (consumer, position) => {
      saved.push(position);
      await save(consumer, position);
    };
    h.rows.push(row(1, "alice/1"), row(2, "alice/2"), row(3, "alice/3"));
    await h.fanout.start();
    await tick();
    expect(saved).toEqual([2, 3]);
    expect(h.published).toHaveLength(3);
  });

  it("goes on from the end when rows after its position were pruned", async () => {
    const h = harness([row(5, "alice/kept.txt")], { cursor: 1 });
    h.state.oldest = 5;
    await h.fanout.start();
    await tick();
    expect(h.published).toEqual([]);
    expect(h.fanout.position()).toBe(5);
    expect(h.state.saved.get(JOURNAL_CONSUMER)).toBe(5);
    expect(h.warnings).toEqual(["journal: rows after the API's position were pruned"]);
  });

  it("reads again when woken during a read, and once more after a failed one", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([], { cursor: 0, retryMs: 1000 });
      await h.fanout.start();
      await vi.advanceTimersByTimeAsync(0);
      h.rows.push(row(1, "alice/a"));
      h.fanout.wake();
      h.rows.push(row(2, "alice/b"));
      h.fanout.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fanout.position()).toBe(2);

      h.state.failReads = 1;
      h.rows.push(row(3, "alice/c"));
      h.fanout.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.warnings).toEqual(["journal: read failed, trying again"]);
      expect(h.fanout.position()).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.fanout.position()).toBe(3);

      // A failure whose retry a notification overtakes reads at once.
      h.state.failReads = 1;
      h.rows.push(row(4, "alice/d"));
      h.fanout.wake();
      await vi.advanceTimersByTimeAsync(0);
      h.fanout.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fanout.position()).toBe(4);
      await h.fanout.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing before start or after stop", async () => {
    const h = harness([], { cursor: 0 });
    h.rows.push(row(1, "alice/a"));
    h.fanout.wake();
    await tick();
    expect(h.state.reads).toBe(0);
    await h.fanout.start();
    await tick();
    await h.fanout.stop();
    h.rows.push(row(2, "alice/b"));
    h.fanout.wake();
    await tick();
    expect(h.fanout.position()).toBe(1);
  });

  it("stops part way through a page", async () => {
    const h = harness([], { cursor: 0 });
    h.rows.push(row(1, "alice/a", null, "watcher"), row(2, "alice/b", null, "watcher"));
    h.outside.mockImplementationOnce(async () => {
      void h.fanout.stop();
    });
    await h.fanout.start();
    await tick();
    expect(h.fanout.position()).toBe(1);
    expect(h.state.saved.get(JOURNAL_CONSUMER)).toBe(0);
  });

  it("skips a login whose scopes are unavailable", async () => {
    const h = harness([], {
      cursor: 0,
      identities: { listAll: async () => [identity("alice"), identity("not a segment")] },
    });
    h.rows.push(row(1, "alice/a"));
    await h.fanout.start();
    await tick();
    expect(h.seen()).toEqual(["alice: change /a @1"]);
  });
});

describe("replay", () => {
  async function replayed(
    h: ReturnType<typeof harness>,
    username: string,
    after: number,
    upTo: number,
  ) {
    const sent: [FsEvent, number][] = [];
    const ok = await h.fanout.replay(username, after, upTo, (event, position) =>
      sent.push([event, position]),
    );
    return {
      ok,
      sent: sent.map(([event, position]) => `${event.op} ${event.paths[0]} @${position}`),
    };
  }

  it("sends the rows a login sees between two positions, and no further", async () => {
    const h = harness(
      [
        row(1, "alice/Project/a"),
        row(2, "carol/x"),
        row(3, "alice/Project/b"),
        row(4, "alice/Project/c"),
      ],
      { pageSize: 1 },
    );
    expect(await replayed(h, "bob", 0, 3)).toEqual({
      ok: true,
      sent: ["change /Shared with me/Project/a @1", "change /Shared with me/Project/b @3"],
    });
    expect(await replayed(h, "bob", 3, 3)).toEqual({ ok: true, sent: [] });
    // A login without a home folder has no scopes: its browser resyncs.
    expect(await replayed(h, "nobody", 0, 4)).toEqual({ ok: false, sent: [] });
  });

  it("says when the rows are gone or cannot be read", async () => {
    const h = harness([row(5, "alice/a")]);
    h.state.oldest = 5;
    expect((await replayed(h, "alice", 2, 5)).ok).toBe(false);
    h.state.failReads = 1;
    expect((await replayed(h, "alice", 4, 5)).ok).toBe(false);
    expect(h.warnings).toEqual(["journal: replay failed, the browser resyncs"]);
  });

  it("stops at the journal's end when fewer rows exist than asked for", async () => {
    const h = harness([row(1, "alice/a")]);
    expect(await replayed(h, "alice", 0, 9)).toEqual({ ok: true, sent: ["change /a @1"] });
  });
});
