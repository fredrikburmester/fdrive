import { StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { Change } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import type { ActivityObservations } from "../activity/observations.js";
import type { MetadataService } from "../metadata/service.js";
import type { Login, SeenChange } from "./journal.js";
import { createOutsideChanges } from "./outside.js";

const login = (username: string): Login => ({
  id: `id-${username}`,
  accountId: `account-${username}`,
  username,
  scopes: [],
});
const ALICE = login("alice");
const ACTOR = { accountId: "account-alice", identityId: "id-alice" };

function seen(path: string | null, target: string | null, move: boolean): SeenChange {
  const change: Change = {
    position: 1,
    path: "alice/x",
    targetPath: move ? "alice/y" : null,
    source: "watcher",
    content: null,
    createdAt: new Date(),
  };
  return { change, path, target };
}

async function harness() {
  const storage = createMemoryStorage();
  await storage.mkdir("/docs");
  await storage.upload("/docs/a.txt", new Uint8Array([1, 2]));
  const calls: string[] = [];
  const recorder = (who: string) => ({
    onMoved: vi.fn(async (identityId: string, from: string, to: string) => {
      calls.push(`${who} moved ${identityId} ${from} -> ${to}`);
    }),
    onDeleted: vi.fn(async (identityId: string, path: string) => {
      calls.push(`${who} deleted ${identityId} ${path}`);
    }),
  });
  const metadata = recorder("metadata");
  const share = recorder("shares");
  const observations = {
    moved: vi.fn(async (..._args: unknown[]) => undefined),
    absent: vi.fn(async (..._args: unknown[]) => undefined),
    present: vi.fn(async (..._args: unknown[]) => undefined),
  };
  const apply = createOutsideChanges({
    metadata: metadata as unknown as MetadataService,
    followers: [share],
    storageFor: async () => storage,
    observations: observations as unknown as ActivityObservations,
  });
  return { storage, calls, observations, apply };
}

describe("createOutsideChanges", () => {
  it("moves what is kept by path along with a move the owner sees both ends of, access first", async () => {
    const h = await harness();
    await h.apply(ALICE, seen("/old", "/docs", true));
    expect(h.calls).toEqual([
      "shares moved id-alice /old -> /docs",
      "metadata moved id-alice /old -> /docs",
    ]);
    expect(h.observations.moved).toHaveBeenCalledWith(ACTOR, h.storage, "/old", "/docs");
  });

  it("moves only the own metadata of someone the folder is shared with", async () => {
    const h = await harness();
    await h.apply(login("bob"), seen("/Shared with me/x", "/Shared with me/y", true));
    // The owner's links would follow from bob's paths too: they wait for the owner's pass.
    await h.apply(login("bob"), seen("/Shared with me/x", null, true));
    expect(h.calls).toEqual([
      "metadata moved id-bob /Shared with me/x -> /Shared with me/y",
      "metadata deleted id-bob /Shared with me/x",
    ]);
  });

  it("drops it for a move out of the login's files, and does nothing for one into them", async () => {
    const h = await harness();
    await h.apply(ALICE, seen("/docs", null, true));
    expect(h.calls).toEqual(["shares deleted id-alice /docs", "metadata deleted id-alice /docs"]);
    expect(h.observations.absent).toHaveBeenCalledWith(ACTOR, "/docs", "left_scope");
    await h.apply(ALICE, seen(null, "/docs", true));
    expect(h.calls).toHaveLength(2);
  });

  it("looks again: compares what is there, and drops what is gone", async () => {
    const h = await harness();
    await h.apply(ALICE, seen("/docs/a.txt", null, false));
    expect(h.observations.present).toHaveBeenCalledWith(
      ACTOR,
      "/docs/a.txt",
      expect.objectContaining({ kind: "file", size: 2 }),
    );
    expect(h.calls).toEqual([]);
    await h.apply(ALICE, seen("/docs/gone.txt", null, false));
    expect(h.calls).toEqual([
      "shares deleted id-alice /docs/gone.txt",
      "metadata deleted id-alice /docs/gone.txt",
    ]);
    expect(h.observations.absent).toHaveBeenCalledWith(ACTOR, "/docs/gone.txt", "missing");
  });

  it("drops nothing it cannot prove gone: an unreadable path or a folder that does not list", async () => {
    const h = await harness();
    vi.spyOn(h.storage, "stat").mockRejectedValueOnce(
      new StorageError("upstream_unavailable", "files folder missing"),
    );
    await h.apply(ALICE, seen("/docs/a.txt", null, false));
    // Its folder is gone too, as when the whole files folder went away.
    await h.apply(ALICE, seen("/missing/a.txt", null, false));
    expect(h.calls).toEqual([]);
    expect(h.observations.absent).not.toHaveBeenCalled();
    expect(h.observations.present).not.toHaveBeenCalled();
  });
});
