import type { SystemEventRepo } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import {
  createSystemEventLog,
  DEFAULT_EVENT_KEEP,
  DEFAULT_PRUNE_EVERY,
  noopSystemEventLog,
} from "./event-log.js";

function fakeRepo(overrides: Partial<SystemEventRepo> = {}) {
  const appended: unknown[] = [];
  const pruned: { subsystem: string; keep: number }[] = [];
  const repo: SystemEventRepo = {
    append: async (input) => {
      appended.push(input);
    },
    list: async () => [],
    prune: async (subsystem, keep) => {
      pruned.push({ subsystem, keep });
    },
    ...overrides,
  };
  return { repo, appended, pruned };
}

/** Lets the fire-and-forget promise chain settle before asserting on it. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("createSystemEventLog", () => {
  it("appends the recorded event and omits data when none was given", async () => {
    const { repo, appended } = fakeRepo();
    const log = createSystemEventLog({ repo, logger: { warn: vi.fn() } });

    log.record("indexer", "info", "Reindex requested", { root: "sftpgo" });
    log.record("ocr", "warn", "Index clear requested");
    await settle();

    expect(appended).toEqual([
      {
        subsystem: "indexer",
        level: "info",
        message: "Reindex requested",
        data: { root: "sftpgo" },
      },
      { subsystem: "ocr", level: "warn", message: "Index clear requested" },
    ]);
  });

  it("swallows a rejecting repository and logs it once per failed write", async () => {
    const failure = new Error("database is down");
    const { repo } = fakeRepo({ append: async () => Promise.reject(failure) });
    const warn = vi.fn();
    const log = createSystemEventLog({ repo, logger: { warn } });

    expect(() => log.record("search", "error", "Reembed failed: boom")).not.toThrow();
    await settle();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ err: failure, subsystem: "search" });
    expect(warn.mock.calls[0]?.[1]).toBe("system event not recorded");
  });

  it("reports a failing prune the same way as a failing append", async () => {
    const { repo } = fakeRepo({ prune: async () => Promise.reject(new Error("no")) });
    const warn = vi.fn();
    const log = createSystemEventLog({ repo, logger: { warn }, pruneEvery: 1 });

    log.record("office", "info", "Office settings updated");
    await settle();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("prunes every Nth write, per subsystem", async () => {
    const { repo, pruned } = fakeRepo();
    const log = createSystemEventLog({ repo, logger: { warn: vi.fn() }, pruneEvery: 3, keep: 7 });

    for (let i = 0; i < 6; i += 1) {
      log.record("indexer", "info", `event ${i}`);
      await settle();
    }
    log.record("ocr", "info", "one");
    await settle();

    expect(pruned).toEqual([
      { subsystem: "indexer", keep: 7 },
      { subsystem: "indexer", keep: 7 },
    ]);
  });

  it("defaults to keeping 2000 rows and pruning every 50th write", async () => {
    const { repo, pruned } = fakeRepo();
    const log = createSystemEventLog({ repo, logger: { warn: vi.fn() } });

    for (let i = 0; i < DEFAULT_PRUNE_EVERY; i += 1) {
      log.record("thumbnails", "info", `event ${i}`);
      await settle();
    }

    expect(pruned).toEqual([{ subsystem: "thumbnails", keep: DEFAULT_EVENT_KEEP }]);
  });
});

describe("noopSystemEventLog", () => {
  it("records nothing and never throws", () => {
    expect(() => noopSystemEventLog.record("office", "info", "ignored", { a: 1 })).not.toThrow();
  });
});
