import { randomUUID } from "node:crypto";
import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { ActivityObservationsRepo, IdentityRepo } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal.js";
import type { IndexerEventPayload } from "../events/indexer-listener.js";
import { createActivityObservations } from "./observations.js";

async function fixture() {
  const accountId = randomUUID(),
    identityId = randomUUID();
  const storage = createMemoryStorage();
  await storage.upload("/a.txt", new Uint8Array([1]));
  const principal: Principal = { accountId, identityId, storage, username: "a", isAdmin: false };
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
    children: vi.fn(async (_account: string, _identity: string, _path: string, _after?: string) => [
      file,
    ]),
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
    configuredMappings: vi.fn(async () => ({
      available: true as const,
      providerId: randomUUID(),
      homeTemplateRaw: "data:/physical/{username}",
      scopes: [{ virtualPrefix: "/", rootName: "data", fsPrefix: "/physical/alice" }],
    })),
  };
  const onError = vi.fn();
  const service = createActivityObservations({
    repo: repo as ActivityObservationsRepo,
    identities: identities as unknown as IdentityRepo,
    storageFactory: async () => storage,
    resolver,
    onError,
  });
  const event = (
    kind: IndexerEventPayload["kind"],
    path = "physical/alice/a.txt",
    target: string | null = null,
  ): IndexerEventPayload => ({
    kind,
    root: "data",
    path,
    target_path: target,
    at: new Date().toISOString(),
  });
  return {
    principal,
    storage,
    file,
    repo,
    identities,
    resolver,
    onError,
    service,
    event,
    accountId,
    identityId,
  };
}
describe("provider observation evidence", () => {
  it("suppresses unreadable destinations and pages known descendants on a proved departure", async () => {
    const h = await fixture();
    await h.storage.upload("/b.txt", new Uint8Array([1]));
    const download = h.storage.download.bind(h.storage);
    vi.spyOn(h.storage, "download").mockRejectedValueOnce(new StorageError("forbidden", "denied"));
    await h.service.watcher(
      h.identityId,
      h.event("moved", "physical/alice/a.txt", "physical/alice/b.txt"),
    );
    expect(h.repo.observe).not.toHaveBeenCalled();
    vi.mocked(h.storage.download)
      .mockImplementationOnce(download)
      .mockRejectedValueOnce(new StorageError("forbidden", "denied"));
    await h.service.watcher(
      h.identityId,
      h.event("moved", "physical/alice/a.txt", "physical/alice/b.txt"),
    );
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
  it("uses fresh reads, distinguishes missing from denied/offline, and never observes a folder visit", async () => {
    const h = await fixture();
    expect(await h.service.check(h.principal, "/a.txt")).toEqual({ checked: true });
    expect(h.repo.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "present",
        source: "refresh",
        accountId: h.accountId,
        after: expect.objectContaining({ size: 1 }),
      }),
    );
    await h.storage.mkdir("/d");
    await h.service.check(h.principal, "/d");
    expect(h.repo.observe.mock.calls.at(-1)?.[0].after?.kind).toBe("dir");
    await h.service.check(h.principal, "/missing");
    expect(h.repo.observe.mock.calls.at(-1)?.[0].kind).toBe("missing");
    h.repo.observe.mockClear();
    const denied = {
      ...h.principal,
      storage: {
        ...h.storage,
        download: async () => {
          throw new StorageError("forbidden", "private");
        },
      } as StorageProvider,
    };
    expect(await h.service.check(denied, "/a.txt")).toEqual({ checked: false });
    expect(
      await h.service.check(
        {
          ...h.principal,
          storage: {
            ...h.storage,
            stat: async () => {
              throw Error("offline");
            },
          },
        },
        "/a.txt",
      ),
    ).toEqual({ checked: false });
    expect(
      await h.service.check(
        {
          ...h.principal,
          storage: {
            ...h.storage,
            list: async () => {
              throw Error("offline");
            },
          },
        },
        "/missing",
      ),
    ).toEqual({ checked: false });
    expect(h.repo.observe).not.toHaveBeenCalled();
  });
  it("compares complete refreshes without probing unchanged files and rotates bounded candidate pages", async () => {
    const h = await fixture();
    const entries = await h.storage.list("/");
    const entry = entries[0];
    if (!entry) throw Error("fixture missing");
    h.file.fingerprint = `stat:${JSON.stringify([entry.size, entry.modifiedAt.toISOString()])}`;
    await h.service.refresh(h.principal, "/", entries);
    expect(h.repo.observe).not.toHaveBeenCalled();
    h.file.fingerprint = null;
    h.repo.children.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, i) => ({ ...h.file, id: String(i) })),
    );
    await h.service.refresh(h.principal, "/", []);
    expect(h.repo.observe).toHaveBeenCalledTimes(8);
    await h.service.refresh(h.principal, "/", []);
    expect(h.repo.children).toHaveBeenLastCalledWith(h.accountId, h.identityId, "/", "7");
    h.repo.children.mockRejectedValueOnce(Error("db offline"));
    await h.service.refresh(h.principal, "/", []);
    expect(h.onError).toHaveBeenCalledOnce();
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
    h.resolver.configuredMappings.mockResolvedValueOnce({
      available: false,
      reason: "no_roots",
    } as never);
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
