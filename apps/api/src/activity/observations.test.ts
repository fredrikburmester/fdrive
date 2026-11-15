import { randomUUID } from "node:crypto";
import { StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { ActivityObservationsRepo } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { createActivityObservations } from "./observations.js";

async function fixture() {
  const actor = { accountId: randomUUID(), identityId: randomUUID() };
  const storage = createMemoryStorage();
  await storage.upload("/a.txt", new Uint8Array([1]));
  const file = {
    id: randomUUID() as string,
    identityId: actor.identityId,
    kind: "file" as const,
    path: "/a.txt",
    state: "live" as const,
    generation: 1,
    revisionId: null,
    firstObservedAt: new Date(),
    lastConfirmedAt: new Date(),
    fingerprint: null as string | null,
  };
  const repo = {
    observe: vi.fn(async (_input: Parameters<ActivityObservationsRepo["observe"]>[0]) => null),
    tracked: vi.fn(async (_account: string, _identity: string, _path: string, _after?: string) => [
      file,
    ]),
  };
  const service = createActivityObservations({ repo: repo as unknown as ActivityObservationsRepo });
  return { actor, storage, file, repo, service };
}

describe("activity observations of changes made outside fdrive", () => {
  it("records a tracked move, folder members included, in the login's own paths", async () => {
    const h = await fixture();
    await h.storage.upload("/b.txt", new Uint8Array([1]));
    await h.service.moved(h.actor, h.storage, "/a.txt", "/b.txt");
    expect(h.repo.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ...h.actor,
        path: "/a.txt",
        kind: "moved",
        evidence: "watcher_move",
        after: expect.objectContaining({ path: "/b.txt", kind: "file", size: 1 }),
      }),
    );
    await h.storage.mkdir("/moved");
    await h.storage.upload("/moved/child.txt", new Uint8Array([2]));
    h.repo.tracked.mockResolvedValueOnce([
      { ...h.file, path: "/folder", kind: "dir" } as never,
      { ...h.file, id: randomUUID(), path: "/folder/child.txt" },
    ]);
    await h.service.moved(h.actor, h.storage, "/folder", "/moved");
    expect(h.repo.observe.mock.calls.at(-2)?.[0].after).toMatchObject({
      path: "/moved",
      kind: "dir",
    });
    expect(h.repo.observe.mock.calls.at(-1)?.[0].after?.path).toBe("/moved/child.txt");
  });

  it("records nothing for a move whose destination it cannot read", async () => {
    const h = await fixture();
    vi.spyOn(h.storage, "stat").mockRejectedValueOnce(new StorageError("forbidden", "denied"));
    await expect(h.service.moved(h.actor, h.storage, "/a.txt", "/b.txt")).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(h.repo.observe).not.toHaveBeenCalled();
  });

  it("pages tracked files under a path that went, and names no outside destination", async () => {
    const h = await fixture();
    const children = Array.from({ length: 100 }, (_, index) => ({
      ...h.file,
      id: randomUUID(),
      path: `/folder/${index}`,
    }));
    h.repo.tracked.mockResolvedValueOnce(children).mockResolvedValueOnce([]);
    await h.service.absent(h.actor, "/folder", "left_scope");
    expect(h.repo.observe).toHaveBeenCalledTimes(100);
    expect(h.repo.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "left_scope", evidence: "watcher_move" }),
    );
    expect(h.repo.tracked).toHaveBeenLastCalledWith(
      h.actor.accountId,
      h.actor.identityId,
      "/folder",
      children.at(-1)?.id,
    );
    await h.service.absent(h.actor, "/a.txt", "missing");
    expect(h.repo.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/a.txt", kind: "missing", evidence: "watcher_change" }),
    );
  });

  it("compares what is at a path now", async () => {
    const h = await fixture();
    await h.service.present(h.actor, "/a.txt", await h.storage.stat("/a.txt"));
    expect(h.repo.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: "/a.txt",
        kind: "present",
        evidence: "watcher_change",
        after: expect.objectContaining({ path: "/a.txt", kind: "file", size: 1 }),
      }),
    );
    await h.service.present(h.actor, "/d", {
      kind: "dir",
      size: 0,
      modifiedAt: null,
      contentType: null,
    });
    expect(h.repo.observe.mock.calls.at(-1)?.[0].after).toMatchObject({
      kind: "dir",
      modifiedAt: null,
    });
  });
});
