import type { FsEvent } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { createEventBus } from "./bus.js";
import type { JournalFanout } from "./journal.js";
import { registerEventRoutes } from "./routes.js";

function notImplemented(): never {
  throw new Error("not implemented in this fake");
}

const FAKE_STORAGE: StorageProvider = {
  list: notImplemented,
  stat: notImplemented,
  statFile: notImplemented,
  download: notImplemented,
  upload: notImplemented,
  mkdir: notImplemented,
  move: notImplemented,
  copy: notImplemented,
  deleteFile: notImplemented,
  deleteDir: notImplemented,
  deleteEmptyDir: notImplemented,
  setModifiedAt: notImplemented,
  zip: notImplemented,
  trash: {
    put: notImplemented,
    list: notImplemented,
    restore: notImplemented,
    purge: notImplemented,
  },
};

const PRINCIPAL: Principal = {
  accountId: "00000000-0000-4000-8000-000000000001",
  identityId: "00000000-0000-4000-8000-000000000002",
  username: "alice",
  storage: FAKE_STORAGE,
  isAdmin: false,
};

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_STORAGE_ROOT: "/srv/files",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

function createTestLogger(): Logger {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return logger as unknown as Logger;
}

const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const AT = "2024-01-01T00:00:01.000Z";

/** A journal at `position`, whose history for the caller is `rows` (`null` for a gap). */
function fakeJournal(rows: [number, string][] | null = [], position = 10) {
  const state = { position, replays: [] as [string, number, number][] };
  const journal: Pick<JournalFanout, "epoch" | "position" | "replay"> = {
    epoch: () => EPOCH,
    position: () => state.position,
    async replay(username, after, upTo, send) {
      state.replays.push([username, after, upTo]);
      if (rows === null) return false;
      for (const [at, path] of rows) {
        if (at > after && at <= upTo)
          send({ type: "fs", op: "change", paths: [path], at: AT } satisfies FsEvent, at);
      }
      return true;
    },
  };
  return { journal, state };
}

function buildApp(
  options: { pingIntervalMs?: number; journal?: ReturnType<typeof fakeJournal> } = {},
) {
  const bus = createEventBus();
  const fake = options.journal ?? fakeJournal();
  const config = loadConfig(REQUIRED_ENV);
  const clock = () => new Date("2024-01-01T00:00:00.000Z");
  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date("2024-01-01T00:00:00.000Z"),
    clock,
    principalResolver: async () => PRINCIPAL,
    setupRequired: async () => false,
    registerRoutes: (groups) => {
      registerEventRoutes(groups, {
        bus,
        journal: fake.journal,
        clock,
        ...(options.pingIntervalMs !== undefined ? { pingIntervalMs: options.pingIntervalMs } : {}),
      });
    },
  });
  return { app, bus, state: fake.state };
}

interface Frame {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: { type: string; paths?: string[]; op?: string };
}

/** Opens the stream and reads frames off it as they come. */
async function open(app: ReturnType<typeof buildApp>["app"], init: RequestInit = {}, url = "") {
  const controller = new AbortController();
  const res = await app.request(`/api/v1/events${url}`, { ...init, signal: controller.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let buffer = "";
  async function next(count = 1): Promise<Frame[]> {
    const frames: Frame[] = [];
    while (frames.length < count) {
      const end = buffer.indexOf("\n\n");
      if (end === -1) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        continue;
      }
      const lines = buffer.slice(0, end).split("\n");
      buffer = buffer.slice(end + 2);
      const field = (name: string) =>
        lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
      frames.push({
        event: field("event") as string,
        id: field("id"),
        data: JSON.parse(field("data") as string),
      });
    }
    return frames;
  }
  const close = async () => {
    controller.abort();
    await reader.cancel();
  };
  return { res, next, close };
}

const describeFrame = (frame: Frame) =>
  `${frame.event}${frame.id === undefined ? "" : ` #${frame.id.slice(EPOCH.length + 1)}`}${frame.data.paths ? ` ${frame.data.paths[0]}` : ""}`;

describe("registerEventRoutes", () => {
  it("starts now with a ping carrying the journal's position, and sets no-store / no-buffering headers", async () => {
    const { app } = buildApp();
    const stream = await open(app);

    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get("Cache-Control")).toBe("no-store");
    expect(stream.res.headers.get("X-Accel-Buffering")).toBe("no");
    const [ping] = await stream.next();
    expect(ping).toEqual({
      event: "ping",
      id: `${EPOCH}.10`,
      data: { type: "ping", at: expect.any(String) },
    });
    await stream.close();
  });

  it("forwards the caller's fs events with their position, without the routing fields", async () => {
    const { app, bus } = buildApp();
    const stream = await open(app);
    await stream.next();

    bus.publish({
      type: "fs",
      op: "change",
      identityId: PRINCIPAL.identityId,
      position: 11,
      paths: ["/a.txt"],
      at: AT,
    });
    bus.publish({
      type: "fs",
      op: "change",
      identityId: "someone-else",
      position: 12,
      paths: ["/b.txt"],
      at: AT,
    });
    bus.publish({ type: "indexed", at: AT });

    const frames = await stream.next(2);
    expect(frames.map(describeFrame)).toEqual(["fs #11 /a.txt", "indexed"]);
    expect(frames[0]?.data).toEqual({ type: "fs", op: "change", paths: ["/a.txt"], at: AT });
    await stream.close();
  });

  it("sends a job event without the identity it was routed by", async () => {
    const { app, bus } = buildApp();
    const stream = await open(app);
    await stream.next();
    bus.publish({
      type: "job",
      identityId: PRINCIPAL.identityId,
      at: AT,
      job: {
        id: "job-1",
        kind: "compress",
        state: "running",
        createdAt: AT,
        updatedAt: AT,
        progress: { processed: 0, total: null, bytes: 0 },
      },
    });
    const [frame] = await stream.next();
    expect(frame?.event).toBe("job");
    expect(frame?.id).toBeUndefined();
    expect(frame?.data).not.toHaveProperty("identityId");
    await stream.close();
  });

  it("replays what a reconnecting browser missed, then goes on live without repeating it", async () => {
    const journal = fakeJournal([
      [6, "/missed-1.txt"],
      [9, "/missed-2.txt"],
    ]);
    const { app, bus, state } = buildApp({ journal });
    const stream = await open(app, { headers: { "Last-Event-ID": `${EPOCH}.5` } });

    const frames = await stream.next(3);
    expect(frames.map(describeFrame)).toEqual([
      "fs #6 /missed-1.txt",
      "fs #9 /missed-2.txt",
      "ping #10",
    ]);
    expect(state.replays).toEqual([["alice", 5, 10]]);
    bus.publish({
      type: "fs",
      op: "change",
      identityId: PRINCIPAL.identityId,
      position: 11,
      paths: ["/live.txt"],
      at: AT,
    });
    expect((await stream.next()).map(describeFrame)).toEqual(["fs #11 /live.txt"]);
    await stream.close();
  });

  it("resumes from the lastEventId query parameter a browser reconnecting itself sends", async () => {
    const journal = fakeJournal([[8, "/missed.txt"]]);
    const { app } = buildApp({ journal });
    const stream = await open(app, {}, `?lastEventId=${EPOCH}.7`);
    expect((await stream.next(2)).map(describeFrame)).toEqual(["fs #8 /missed.txt", "ping #10"]);
    await stream.close();
  });

  it("holds live events back while it replays, and drops those it already sent", async () => {
    const journal = fakeJournal([[6, "/missed.txt"]]);
    const { app, bus } = buildApp({ journal });
    const replay = journal.journal.replay;
    journal.journal.replay = async (username, after, upTo, send) => {
      // A change lands while the replay reads: it waits for the replay.
      bus.publish({
        type: "fs",
        op: "change",
        identityId: PRINCIPAL.identityId,
        position: 11,
        paths: ["/during.txt"],
        at: AT,
      });
      bus.publish({
        type: "fs",
        op: "change",
        identityId: PRINCIPAL.identityId,
        position: 6,
        paths: ["/missed.txt"],
        at: AT,
      });
      return replay(username, after, upTo, send);
    };
    const stream = await open(app, { headers: { "Last-Event-ID": `${EPOCH}.5` } });
    expect((await stream.next(3)).map(describeFrame)).toEqual([
      "fs #6 /missed.txt",
      "fs #11 /during.txt",
      "ping #11",
    ]);
    await stream.close();
  });

  it("goes on from a position past the reader's, which a restarted API may not have reached yet", async () => {
    const { app, bus, state } = buildApp();
    const stream = await open(app, { headers: { "Last-Event-ID": `${EPOCH}.12` } });
    expect((await stream.next()).map(describeFrame)).toEqual(["ping #12"]);
    expect(state.replays).toEqual([]);
    // The reader catches up: what this browser already had is not sent again.
    bus.publish({
      type: "fs",
      op: "change",
      identityId: PRINCIPAL.identityId,
      position: 12,
      paths: ["/seen.txt"],
      at: AT,
    });
    bus.publish({
      type: "fs",
      op: "change",
      identityId: PRINCIPAL.identityId,
      position: 13,
      paths: ["/new.txt"],
      at: AT,
    });
    expect((await stream.next()).map(describeFrame)).toEqual(["fs #13 /new.txt"]);
    await stream.close();
  });

  it.each([
    ["rows after it were pruned", `${EPOCH}.2`],
    ["the database was restored under a new epoch", "00000000-0000-4000-8000-000000000000.2"],
    ["the id cannot be read", "garbage"],
  ])("sends a resync when %s", async (_why, id) => {
    const { app } = buildApp({ journal: fakeJournal(null) });
    const stream = await open(app, { headers: { "Last-Event-ID": id } });
    const frames = await stream.next(2);
    expect(frames.map(describeFrame)).toEqual(["resync #10", "ping #10"]);
    expect(frames[0]?.data).toEqual({ type: "resync", at: expect.any(String) });
    await stream.close();
  });

  it("moves each ping's id on to the reader's position, so a quiet browser stays current", async () => {
    const journal = fakeJournal();
    const { app } = buildApp({ pingIntervalMs: 20, journal });
    const stream = await open(app);
    await stream.next();
    journal.state.position = 25;
    expect((await stream.next()).map(describeFrame)).toEqual(["ping #25"]);
    await stream.close();
  });

  it("unsubscribes when the request is aborted", async () => {
    const { app, bus } = buildApp();
    const controller = new AbortController();

    await app.request("/api/v1/events", { signal: controller.signal });

    expect(bus.subscriberCount(PRINCIPAL.identityId)).toBe(1);

    controller.abort();
    // Let the abort event's listeners (and the cleanup they trigger) run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bus.subscriberCount()).toBe(0);
  });

  it("cleans up immediately when the request arrives already aborted", async () => {
    const { app, bus } = buildApp();
    const controller = new AbortController();
    controller.abort();

    await app.request("/api/v1/events", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bus.subscriberCount()).toBe(0);
  });
});
