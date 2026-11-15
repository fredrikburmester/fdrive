import { randomUUID } from "node:crypto";
import { StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { ActivityObservationsRepo, IdentityRepo } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import type { IndexerEventPayload } from "../events/indexer-listener.js";
import { createActivityObservations } from "./observations.js";

async function fixture() {
  const accountId = randomUUID(),
    identityId = randomUUID();
  const storage = createMemoryStorage();
  await storage.upload("/a.txt", new Uint8Array([1]));
  const file = {
    id: randomUUID() as string,
    identityId,
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
  const identities = {
    get: vi.fn(
      async (_identityId: string) =>
        ({ id: identityId, accountId }) as { id: string; accountId: string } | null,
    ),
  };
  const resolver = {
    scopesFor: vi.fn(async () => [{ virtualPrefix: "/", fsPrefix: "/physical/alice" }]),
  };
  const service = createActivityObservations({
    repo: repo as ActivityObservationsRepo,
    identities: identities as unknown as IdentityRepo,
    storageFactory: async () => storage,
    resolver,
  });
  const event = (
    kind: IndexerEventPayload["kind"],
    path = "physical/alice/a.txt",
    target: string | null = null,
  ): IndexerEventPayload => ({
    kind,
    path,
    target_path: target,
    at: new Date().toISOString(),
  });
  return {
    storage,
    file,
    repo,
    identities,
    resolver,
    service,
    event,
    accountId,
    identityId,
  };
}
describe("indexer observation evidence", () => {
  it("records no absence it cannot prove and pages known descendants on a proved departure", async () => {
    const h = await fixture();
    // A destination storage cannot read records nothing.
    vi.spyOn(h.storage, "stat").mockRejectedValueOnce(new StorageError("forbidden", "denied"));
    await expect(
      h.service.watcher(
        h.identityId,
        h.event("moved", "physical/alice/a.txt", "physical/alice/b.txt"),
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(h.repo.observe).not.toHaveBeenCalled();
    await h.storage.deleteFile("/a.txt");
    vi.spyOn(h.storage, "list").mockRejectedValueOnce(new StorageError("forbidden", "denied"));
    await h.service.watcher(h.identityId, h.event("deleted"));
    expect(h.repo.observe).not.toHaveBeenCalled();
    const children = Array.from({ length: 100 }, (_, index) => ({
      ...h.file,
      id: randomUUID(),
      path: `/folder/${index}`,
    }));
    h.repo.tracked.mockResolvedValueOnce(children).mockResolvedValueOnce([]);
    await h.service.watcher(
      h.identityId,
      h.event("moved", "physical/alice/folder", "outside/private"),
    );
    expect(h.repo.observe).toHaveBeenCalledTimes(100);
    expect(h.repo.tracked).toHaveBeenLastCalledWith(
      h.accountId,
      h.identityId,
      "/folder",
      children.at(-1)?.id,
    );
    expect(JSON.stringify(h.repo.observe.mock.calls)).not.toContain("outside/private");
  });
  it("maps physical signals to virtual coordinates, handles changes and records only proved absence", async () => {
    const h = await fixture();
    await h.service.watcher(h.identityId, h.event("created"));
    await h.service.watcher(h.identityId, h.event("changed"));
    expect(h.repo.observe).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.repo.observe.mock.calls)).not.toContain("physical");
    await h.service.watcher(h.identityId, h.event("deleted"));
    expect(h.repo.observe).toHaveBeenCalledTimes(2);
    await h.storage.deleteFile("/a.txt");
    await h.service.watcher(h.identityId, h.event("deleted"));
    expect(h.repo.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/a.txt", kind: "missing", evidence: "watcher_change" }),
    );
    h.identities.get.mockResolvedValueOnce(null);
    await h.service.watcher(h.identityId, h.event("created"));
    await h.service.watcher(h.identityId, h.event("created", "outside/alice/a.txt"));
    expect(h.repo.observe).toHaveBeenCalledTimes(3);
  });
  it("preserves a tracked move, including folder members, without hash-merging a candidate", async () => {
    const h = await fixture();
    await h.storage.upload("/b.txt", new Uint8Array([1]));
    await h.service.watcher(
      h.identityId,
      h.event("moved", "physical/alice/a.txt", "physical/alice/b.txt"),
    );
    expect(h.repo.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: "/a.txt",
        kind: "moved",
        after: expect.objectContaining({ path: "/b.txt" }),
      }),
    );
    await h.service.watcher(
      h.identityId,
      h.event("moved", "physical/alice/a.txt", "outside/secret"),
    );
    expect(h.repo.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "left_scope" }),
    );
    expect(JSON.stringify(h.repo.observe.mock.calls)).not.toContain("secret");
    expect(await h.service.tracks(h.identityId, "/a.txt")).toBe(true);
    h.identities.get.mockResolvedValueOnce(null);
    expect(await h.service.tracks(h.identityId, "/a.txt")).toBe(false);
    await h.service.relink(h.identityId, "/a.txt", "/b.txt");
    expect(h.repo.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "continuity_unknown",
        evidence: "sha256_relink",
        after: { targetPath: "/b.txt" },
      }),
    );
    h.identities.get.mockResolvedValueOnce(null);
    await h.service.relink(h.identityId, "/a.txt", "/b.txt");
    await h.service.relink(h.identityId, "/a.txt", "/missing");
    await h.storage.mkdir("/moved");
    await h.storage.upload("/moved/child.txt", new Uint8Array([2]));
    h.repo.tracked.mockResolvedValueOnce([
      { ...h.file, path: "/folder", kind: "dir" } as never,
      { ...h.file, id: randomUUID(), path: "/folder/child.txt" },
    ]);
    await h.service.watcher(
      h.identityId,
      h.event("moved", "physical/alice/folder", "physical/alice/moved"),
    );
    expect(h.repo.observe.mock.calls.at(-1)?.[0].after?.path).toBe("/moved/child.txt");
  });
});
