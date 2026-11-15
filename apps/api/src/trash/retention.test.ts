import { moveTrashLeafPath } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { Identity } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { activityFixture } from "../../test/activity-fixture.js";
import { ApiHttpError } from "../errors.js";
import { createMetadataService, withFollowers } from "../metadata/service.js";
import { createTrashRetention } from "./retention.js";

const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-11-15T12:00:00.000Z");

function identity(id: string, username: string): Identity {
  return {
    id,
    accountId: `${id}-account`,
    providerId: "provider",
    externalUsername: username,
    createdAt: NOW,
    lastLoginAt: null,
  };
}

/** Alice's storage with Trash, and a way to move an item to Trash `daysAgo`. */
function aliceStorage() {
  let at = NOW;
  const storage = createMemoryStorage(
    { "/old.txt": "old", "/new.txt": "new", "/Old/a.txt": "a" },
    { clock: () => at },
  );
  return {
    storage,
    async deleteDaysAgo(path: string, daysAgo: number, kind: "file" | "dir" = "file") {
      at = new Date(NOW.getTime() - daysAgo * DAY);
      await storage.trash.put(path);
      at = NOW;
      return moveTrashLeafPath(
        "/.trash",
        path,
        kind,
        (BigInt(NOW.getTime() - daysAgo * DAY) * 1_000_000n).toString(),
      );
    },
  };
}

function harness(options: { retentionDays?: number; storageFor?: () => Promise<never> } = {}) {
  const alice = aliceStorage();
  const follower = { onMoved: vi.fn(async () => {}), onDeleted: vi.fn(async () => {}) };
  const metadata = withFollowers(createMetadataService(createMemoryRepos()), [follower]);
  const activity = activityFixture(() => NOW);
  const record = vi.fn();
  const retention = createTrashRetention({
    identities: {
      listAll: async () => [identity("alice", "alice"), identity("dora", "dora")],
    },
    storageFor:
      options.storageFor ??
      (async (id) => {
        if (id === "dora") throw new ApiHttpError("forbidden", "this user may not sign in");
        return alice.storage;
      }),
    settings: { current: async () => ({ retentionDays: options.retentionDays ?? 30 }) },
    activity: activity.service,
    metadata,
    clock: () => NOW,
    eventLog: { record },
  });
  return { alice, follower, activity, record, retention };
}

describe("Trash retention", () => {
  it("deletes only what Trash kept longer than the setting, as a permanent delete with history", async () => {
    const h = harness();
    const old = await h.alice.deleteDaysAgo("/old.txt", 31);
    const folder = await h.alice.deleteDaysAgo("/Old", 45, "dir");
    await h.alice.deleteDaysAgo("/new.txt", 29);

    expect(await h.retention.sweep()).toEqual({ purged: 2, deferred: 0 });

    const left = (await h.alice.storage.trash.list())?.entries.map((entry) => entry.originalPath);
    expect(left).toEqual(["/new.txt"]);
    expect(h.activity.operations.map((operation) => operation.requested)).toEqual(
      expect.arrayContaining([
        { path: "/old.txt", trashLeaf: old, reason: "retention" },
        { path: "/Old", trashLeaf: folder, reason: "retention" },
      ]),
    );
    expect(h.activity.operations).toHaveLength(2);
    expect(h.activity.operations.every((operation) => operation.action === "file.delete")).toBe(
      true,
    );
    expect(h.activity.operations.every((operation) => operation.source === "api")).toBe(true);
    // What followed the items into Trash (shares, links) ends with them.
    expect(h.follower.onDeleted.mock.calls).toEqual(
      expect.arrayContaining([
        ["alice", old, false],
        ["alice", folder, true],
      ]),
    );
    expect(h.record).toHaveBeenCalledWith(
      "general",
      "info",
      "Trash deleted 2 items kept longer than 30 days",
    );
  });

  it("follows the setting and leaves a user who may not sign in alone", async () => {
    const h = harness({ retentionDays: 1 });
    await h.alice.deleteDaysAgo("/new.txt", 2);
    expect(await h.retention.sweep()).toEqual({ purged: 1, deferred: 0 });
    expect(h.record).toHaveBeenCalledWith(
      "general",
      "info",
      "Trash deleted 1 item kept longer than 1 day",
    );
    expect(await h.retention.sweep()).toEqual({ purged: 0, deferred: 0 });
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it("defers an item it cannot delete to the next pass", async () => {
    const h = harness();
    await h.alice.deleteDaysAgo("/old.txt", 40);
    vi.spyOn(h.alice.storage.trash, "purge").mockRejectedValueOnce(new Error("disk busy"));

    expect(await h.retention.sweep()).toEqual({ purged: 0, deferred: 1 });
    expect(h.record).toHaveBeenCalledWith(
      "general",
      "warn",
      "Trash retention deferred an item",
      expect.objectContaining({ identityId: "alice", error: "disk busy" }),
    );
    expect(await h.retention.sweep()).toEqual({ purged: 1, deferred: 0 });
  });

  it("runs hourly, the first time an hour after start, logs a pass that fails, then stops", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const failing = harness({ storageFor: () => Promise.reject("users table unreachable") });
      failing.retention.start();
      failing.retention.start();
      expect(failing.record).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await vi.waitFor(() =>
        expect(failing.record).toHaveBeenCalledWith("general", "error", "Trash retention failed", {
          error: "users table unreachable",
        }),
      );
      await failing.retention.stop();

      const h = harness();
      await h.alice.deleteDaysAgo("/old.txt", 40);
      h.retention.start();
      await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
      expect((await h.alice.storage.trash.list())?.entries).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(async () =>
        expect((await h.alice.storage.trash.list())?.entries).toEqual([]),
      );
      await h.retention.stop();
      // Stopped: a later start does nothing, and neither does a pass.
      h.retention.start();
      expect(await h.retention.sweep()).toEqual({ purged: 0, deferred: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
