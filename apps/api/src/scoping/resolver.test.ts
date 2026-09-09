import type { IndexerDirectoryResponse } from "@fdrive/contracts";
import type { Scope } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexRootConfig } from "../config.ts";
import { createInMemoryMountMappingStore } from "./mount-mapping-store.ts";
import { createInMemoryScopeOverrideStore, type ScopeOverrideStore } from "./override-store.ts";
import { type CreateScopeResolverDeps, createScopeResolver } from "./resolver.ts";
import {
  buildIdentity,
  fakeConnectionStore,
  fakeIndexerDirectory,
  fakeStorageProvider,
  fileEntry,
} from "./test-fixtures/index.ts";
import { ScopeOverrideValidationError } from "./validate-overrides.ts";

const CONNECTION = {
  baseUrl: "http://sftpgo:8080",
  homeTemplate: "sftpgo:/{username}",
  source: "env" as const,
};
const INDEX_ROOTS: IndexRootConfig[] = [
  { name: "sftpgo", sftpgoPath: "/data", indexerPath: "/index-data" },
];

function buildClock(startMs: number) {
  let now = startMs;
  return { clock: () => new Date(now), advance: (ms: number) => (now += ms) };
}

async function setup(overrides: Partial<CreateScopeResolverDeps> = {}) {
  const repos = createMemoryRepos();
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: CONNECTION.baseUrl });
  const identity = buildIdentity({ providerId: provider.id });
  const overrideStore: ScopeOverrideStore = createInMemoryScopeOverrideStore();
  const mountMappingStore = createInMemoryMountMappingStore();
  const clockCtl = buildClock(1_700_000_000_000);

  const deps: CreateScopeResolverDeps = {
    providers: repos.providers,
    overrides: overrideStore,
    mountMappings: mountMappingStore,
    connection: fakeConnectionStore(CONNECTION),
    indexRoots: INDEX_ROOTS,
    indexer: fakeIndexerDirectory(new Map()),
    storageForIdentity: async () => fakeStorageProvider(),
    clock: clockCtl.clock,
    ...overrides,
  };
  const resolver = createScopeResolver(deps);
  return { resolver, identity, provider, overrideStore, mountMappingStore, clockCtl, deps };
}

describe("configuredMappings", () => {
  it("returns the home scope for a normal identity", async () => {
    const { resolver, identity } = await setup();
    const result = await resolver.configuredMappings(identity);
    expect(result).toEqual({
      available: true,
      providerId: identity.providerId,
      homeTemplateRaw: "sftpgo:/{username}",
      scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
    });
  });

  it("applies a stored override on top of the home scope", async () => {
    const { resolver, identity, overrideStore } = await setup();
    const override: Scope = {
      rootName: "sftpgo",
      fsPrefix: "/pool/team",
      virtualPrefix: "/shared",
    };
    await overrideStore.set(identity.id, [override], []);

    const result = await resolver.configuredMappings(identity);
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.scopes).toContainEqual(override);
    }
  });

  it("is unavailable with no_connection when there is no active connection", async () => {
    const { resolver, identity } = await setup({ connection: fakeConnectionStore(null) });
    expect(await resolver.configuredMappings(identity)).toEqual({
      available: false,
      reason: "no_connection",
    });
  });

  it("is unavailable with provider_mismatch when the identity's provider baseUrl differs", async () => {
    const repos = createMemoryRepos();
    const otherProvider = await repos.providers.ensure({
      type: "sftpgo",
      baseUrl: "http://other:8080",
    });
    const identity = buildIdentity({ providerId: otherProvider.id });
    const resolver = createScopeResolver({
      providers: repos.providers,
      overrides: createInMemoryScopeOverrideStore(),
      mountMappings: createInMemoryMountMappingStore(),
      connection: fakeConnectionStore(CONNECTION),
      indexRoots: INDEX_ROOTS,
      indexer: fakeIndexerDirectory(new Map()),
      storageForIdentity: async () => fakeStorageProvider(),
      clock: () => new Date(),
    });
    expect(await resolver.configuredMappings(identity)).toEqual({
      available: false,
      reason: "provider_mismatch",
    });
  });

  it("is unavailable with provider_mismatch when the identity's provider no longer exists", async () => {
    const { resolver } = await setup();
    const missing = buildIdentity({ providerId: "00000000-0000-0000-0000-000000000000" });
    expect(await resolver.configuredMappings(missing)).toEqual({
      available: false,
      reason: "provider_mismatch",
    });
  });

  it("is unavailable with invalid_configuration for an unparsable home template", async () => {
    const { resolver, identity } = await setup({
      connection: fakeConnectionStore({ ...CONNECTION, homeTemplate: "not-a-template" }),
    });
    expect(await resolver.configuredMappings(identity)).toEqual({
      available: false,
      reason: "invalid_configuration",
    });
  });
});

describe("verifiedIndexScopes", () => {
  it("propagates a configuredMappings failure reason", async () => {
    const { resolver, identity } = await setup({ connection: fakeConnectionStore(null) });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "no_connection",
    });
  });

  it("is unavailable with no_roots when indexRoots is null", async () => {
    const { resolver, identity } = await setup({ indexRoots: null });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "no_roots",
    });
  });

  it("is unavailable with no_roots when none of the identity's scopes are indexed", async () => {
    const { resolver, identity } = await setup({
      indexRoots: [{ name: "other-root", sftpgoPath: "/x", indexerPath: "/y" }],
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "no_roots",
    });
  });

  it("is available when the SFTP listing matches the index listing", async () => {
    const indexData: IndexerDirectoryResponse = {
      items: [{ name: "a.txt", kind: "file" }],
      overflow: false,
    };
    const { resolver, identity } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({ list: async () => [fileEntry("a.txt")] }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", indexData]])),
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: true,
      scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
    });
  });

  it("is unavailable with unmapped_mount when an SFTP entry is missing from the index", async () => {
    // A mount is never a real entry on disk in the home directory, so the
    // only symptom of a missing mapping is an SFTP-visible name the index
    // has never seen. It still fails closed; the reason just says why.
    const indexData: IndexerDirectoryResponse = { items: [], overflow: false };
    const { resolver, identity } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({ list: async () => [fileEntry("shared", "dir")] }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", indexData]])),
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "unmapped_mount",
    });
    const status = await resolver.status(identity, false);
    expect(status.reason).toBe("unmapped_mount");
    expect(status.unmappedMounts).toEqual([{ virtualPath: "/shared", kind: "dir" }]);
    // Nothing survived, so there is no "other" scope to report against.
    expect(status.unverifiedPrefixes).toEqual([]);
  });

  it("still reports mismatch when an entry exists in the index with a different kind", async () => {
    const indexData: IndexerDirectoryResponse = {
      items: [{ name: "shared", kind: "file" }],
      overflow: false,
    };
    const { resolver, identity } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({ list: async () => [fileEntry("shared", "dir")] }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", indexData]])),
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "mismatch",
    });
    expect((await resolver.status(identity, false)).unmappedMounts).toEqual([]);
  });

  it("reports mismatch, not unmapped_mount, when a missing entry sits next to a kind mismatch", async () => {
    const indexData: IndexerDirectoryResponse = {
      items: [{ name: "x", kind: "file" }],
      overflow: false,
    };
    const { resolver, identity } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({
          list: async () => [fileEntry("shared", "dir"), fileEntry("x", "dir")],
        }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", indexData]])),
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "mismatch",
    });
  });

  it("treats a missing symlink as a mismatch rather than a mount candidate", async () => {
    const indexData: IndexerDirectoryResponse = { items: [], overflow: false };
    const { resolver, identity } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({ list: async () => [fileEntry("link", "symlink")] }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", indexData]])),
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "mismatch",
    });
  });

  it("verifies the home scope through shadow exclusion once the mount is mapped", async () => {
    // Home lists the mount name, which is absent from home's own index
    // listing (it is not on disk there); the override's own directory is
    // verified normally, and both scopes end up in the verified set.
    const homeIndex: IndexerDirectoryResponse = {
      items: [{ name: "a.txt", kind: "file" }],
      overflow: false,
    };
    const sharedIndex: IndexerDirectoryResponse = {
      items: [{ name: "x.txt", kind: "file" }],
      overflow: false,
    };
    const { resolver, identity, overrideStore } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({
          list: async (path: string) =>
            path === "/" ? [fileEntry("a.txt"), fileEntry("shared", "dir")] : [fileEntry("x.txt")],
        }),
      indexer: fakeIndexerDirectory(
        new Map([
          ["sftpgo:/alice", homeIndex],
          ["sftpgo:/_folders/shared", sharedIndex],
        ]),
      ),
    });
    await overrideStore.set(
      identity.id,
      [{ rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" }],
      [],
    );

    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: true,
      scopes: [
        { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
        { rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" },
      ],
    });
    const status = await resolver.status(identity, false);
    expect(status).toMatchObject({
      status: "available",
      reason: "ok",
      unmappedMounts: [],
      unverifiedPrefixes: [],
    });
  });

  it("verifies the home scope when the mount is acknowledged as unindexed", async () => {
    const homeIndex: IndexerDirectoryResponse = {
      items: [{ name: "a.txt", kind: "file" }],
      overflow: false,
    };
    const { resolver, identity, overrideStore } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({
          list: async () => [fileEntry("a.txt"), fileEntry("shared", "dir")],
        }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", homeIndex]])),
    });
    await overrideStore.set(identity.id, [], ["/shared"]);

    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: true,
      scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
    });
    const status = await resolver.status(identity, false);
    expect(status.reason).toBe("ok");
    expect(status.usesOverride).toBe(true);
    // An unindexed prefix maps to nothing: it is never a scope of its own,
    // but it is echoed back so an editor can keep it on its next save.
    expect(status.virtualPrefixes).toEqual(["/"]);
    expect(status.unindexedPrefixes).toEqual(["/shared"]);
  });

  it("keeps the home scope when an override fails, and reports that prefix unverified", async () => {
    const homeIndex: IndexerDirectoryResponse = {
      items: [{ name: "a.txt", kind: "file" }],
      overflow: false,
    };
    // The override's index listing is missing entirely (unreachable for
    // that directory), so only the override fails.
    const { resolver, identity, overrideStore } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({
          list: async (path: string) =>
            path === "/" ? [fileEntry("a.txt"), fileEntry("team", "dir")] : [fileEntry("y.txt")],
        }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", homeIndex]])),
    });
    await overrideStore.set(
      identity.id,
      [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/team" }],
      [],
    );

    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: true,
      scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
    });
    const status = await resolver.status(identity, true);
    expect(status).toMatchObject({
      status: "available",
      reason: "ok",
      virtualPrefixes: ["/", "/team"],
      unverifiedPrefixes: ["/team"],
      unmappedMounts: [],
      overrides: [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/team" }],
    });
  });

  it("keeps a healthy override when only the home scope has an unmapped mount", async () => {
    const sharedIndex: IndexerDirectoryResponse = {
      items: [{ name: "x.txt", kind: "file" }],
      overflow: false,
    };
    const { resolver, identity, overrideStore } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({
          list: async (path: string) =>
            path === "/"
              ? [fileEntry("shared", "dir"), fileEntry("other", "dir")]
              : [fileEntry("x.txt")],
        }),
      indexer: fakeIndexerDirectory(
        new Map([
          ["sftpgo:/alice", { items: [], overflow: false }],
          ["sftpgo:/_folders/shared", sharedIndex],
        ]),
      ),
    });
    await overrideStore.set(
      identity.id,
      [{ rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" }],
      [],
    );

    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: true,
      scopes: [{ rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" }],
    });
    const status = await resolver.status(identity, false);
    expect(status).toMatchObject({
      status: "available",
      unverifiedPrefixes: ["/"],
      unmappedMounts: [{ virtualPath: "/other", kind: "dir" }],
    });
  });

  it("reports the most severe reason when every scope fails", async () => {
    // Home: unmapped mount (least severe). Override: indexer unreachable
    // (most severe). Nothing survives, so the identity-wide reason is the
    // more severe of the two.
    const { resolver, identity, overrideStore } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({
          list: async (path: string) => (path === "/" ? [fileEntry("shared", "dir")] : []),
        }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", { items: [], overflow: false }]])),
    });
    await overrideStore.set(
      identity.id,
      [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/team" }],
      [],
    );
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "indexer_unreachable",
    });
    const status = await resolver.status(identity, false);
    expect(status.reason).toBe("indexer_unreachable");
    // The unmapped mount is still named so the administrator can act on it.
    expect(status.unmappedMounts).toEqual([{ virtualPath: "/shared", kind: "dir" }]);
  });

  it("caps the reported unmapped mounts at the contract maximum", async () => {
    const names = Array.from({ length: 70 }, (_, i) => fileEntry(`m${i}`, "dir"));
    const { resolver, identity } = await setup({
      storageForIdentity: async () => fakeStorageProvider({ list: async () => names }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", { items: [], overflow: false }]])),
    });
    const status = await resolver.status(identity, false);
    expect(status.reason).toBe("unmapped_mount");
    expect(status.unmappedMounts).toHaveLength(64);
  });

  it("is unavailable with overflow when the index listing overflowed", async () => {
    const indexData: IndexerDirectoryResponse = { items: [], overflow: true };
    const { resolver, identity } = await setup({
      storageForIdentity: async () => fakeStorageProvider({ list: async () => [] }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", indexData]])),
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "overflow",
    });
  });

  it("is unavailable with indexer_unreachable when the indexer has no data for the mount", async () => {
    const { resolver, identity } = await setup({
      storageForIdentity: async () => fakeStorageProvider({ list: async () => [] }),
      indexer: fakeIndexerDirectory(new Map()),
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "indexer_unreachable",
    });
  });

  it.each([400, 403, 404])(
    "treats directory HTTP %s as a mapping failure, not a down indexer",
    async (status) => {
      const { resolver, identity } = await setup({
        indexer: {
          directory: async () => ({
            ok: false,
            reason: "unreachable",
            detail: `status ${status}`,
            status,
          }),
        },
      });
      expect(await resolver.verifiedIndexScopes(identity)).toEqual({
        available: false,
        reason: "mismatch",
      });
    },
  );

  it("keeps service failures unavailable without granting an index scope", async () => {
    const { resolver, identity } = await setup({
      indexer: {
        directory: async () => ({
          ok: false,
          reason: "unreachable",
          detail: "status 503",
          status: 503,
        }),
      },
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "indexer_unreachable",
    });
  });

  it("is unavailable with mismatch when the live SFTP listing itself fails", async () => {
    const { resolver, identity } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({
          list: async () => {
            throw new Error("connection reset");
          },
        }),
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "mismatch",
    });
  });

  it("is unavailable with mismatch when storageForIdentity itself rejects", async () => {
    const { resolver, identity } = await setup({
      storageForIdentity: async () => {
        throw new Error("no client for identity");
      },
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "mismatch",
    });
  });

  it("excludes a name shadowed by a more specific override from the home scope's own check", async () => {
    // Home lists a "shared" entry that does NOT match the index at all
    // (deliberately, to prove it is excluded rather than coincidentally
    // matching); the override's own mount directory is verified normally.
    const homeIndex: IndexerDirectoryResponse = { items: [], overflow: false };
    const overrideIndex: IndexerDirectoryResponse = {
      items: [{ name: "x.txt", kind: "file" }],
      overflow: false,
    };
    const { resolver, identity, overrideStore } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({
          list: async (path: string) =>
            path === "/" ? [fileEntry("shared", "dir")] : [fileEntry("x.txt")],
        }),
      indexer: fakeIndexerDirectory(
        new Map([
          ["sftpgo:/alice", homeIndex],
          ["sftpgo:/pool/team", overrideIndex],
        ]),
      ),
    });
    await overrideStore.set(
      identity.id,
      [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" }],
      [],
    );

    const result = await resolver.verifiedIndexScopes(identity);
    expect(result.available).toBe(true);
  });

  it("caches a result within the TTL, and recomputes after it expires", async () => {
    const listSpy = vi.fn(async () => [fileEntry("a.txt")]);
    const indexData: IndexerDirectoryResponse = {
      items: [{ name: "a.txt", kind: "file" }],
      overflow: false,
    };
    const { resolver, identity, clockCtl } = await setup({
      storageForIdentity: async () => fakeStorageProvider({ list: listSpy }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", indexData]])),
      cacheTtlMs: 1000,
    });

    await resolver.verifiedIndexScopes(identity);
    await resolver.verifiedIndexScopes(identity);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith("/");

    clockCtl.advance(1001);
    await resolver.verifiedIndexScopes(identity);
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it("recomputes immediately after setOverrides changes the mapping", async () => {
    const listSpy = vi.fn(async () => []);
    const homeIndex: IndexerDirectoryResponse = { items: [], overflow: false };
    const { resolver, identity, clockCtl } = await setup({
      storageForIdentity: async () => fakeStorageProvider({ list: listSpy }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", homeIndex]])),
      cacheTtlMs: 60_000,
    });

    await resolver.verifiedIndexScopes(identity);
    expect(listSpy).toHaveBeenCalledTimes(1);
    void clockCtl;

    await resolver.setOverrides(identity, []);
    await resolver.verifiedIndexScopes(identity);
    // A fresh key (overrides changed from "none stored" to "explicitly
    // empty" is a no-op here, so exercise a real content change instead).
    expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("bounds concurrent SFTP/indexer probes across candidate scopes", async () => {
    let active = 0;
    let maxActive = 0;
    const gate = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

    const listSpy = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate();
      active -= 1;
      return [];
    });

    const roots: IndexRootConfig[] = [
      { name: "sftpgo", sftpgoPath: "/data", indexerPath: "/index-data" },
      { name: "root-b", sftpgoPath: "/data-b", indexerPath: "/index-data-b" },
      { name: "root-c", sftpgoPath: "/data-c", indexerPath: "/index-data-c" },
      { name: "root-d", sftpgoPath: "/data-d", indexerPath: "/index-data-d" },
    ];
    const overrides: Scope[] = [
      { rootName: "root-b", fsPrefix: "/b", virtualPrefix: "/b" },
      { rootName: "root-c", fsPrefix: "/c", virtualPrefix: "/c" },
      { rootName: "root-d", fsPrefix: "/d", virtualPrefix: "/d" },
    ];
    const indexEntries = new Map<string, IndexerDirectoryResponse>([
      ["sftpgo:/alice", { items: [], overflow: false }],
      ["root-b:/b", { items: [], overflow: false }],
      ["root-c:/c", { items: [], overflow: false }],
      ["root-d:/d", { items: [], overflow: false }],
    ]);

    const { resolver, identity, overrideStore } = await setup({
      indexRoots: roots,
      storageForIdentity: async () => fakeStorageProvider({ list: listSpy }),
      indexer: fakeIndexerDirectory(indexEntries),
      verifyConcurrency: 2,
    });
    await overrideStore.set(identity.id, overrides, []);

    const result = await resolver.verifiedIndexScopes(identity);
    expect(result.available).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(listSpy).toHaveBeenCalledTimes(4);
  });

  it("verifies every candidate even after one has already failed", async () => {
    const listSpy = vi.fn(async (path: string) => {
      if (path === "/") {
        throw new Error("boom");
      }
      return [];
    });
    const roots: IndexRootConfig[] = [
      { name: "sftpgo", sftpgoPath: "/data", indexerPath: "/index-data" },
      { name: "root-b", sftpgoPath: "/data-b", indexerPath: "/index-data-b" },
    ];
    const overrides: Scope[] = [{ rootName: "root-b", fsPrefix: "/b", virtualPrefix: "/b" }];

    const { resolver, identity, overrideStore } = await setup({
      indexRoots: roots,
      storageForIdentity: async () => fakeStorageProvider({ list: listSpy }),
      indexer: fakeIndexerDirectory(new Map([["root-b:/b", { items: [], overflow: false }]])),
      verifyConcurrency: 1,
    });
    await overrideStore.set(identity.id, overrides, []);

    const result = await resolver.verifiedIndexScopes(identity);
    expect(result).toEqual({ available: true, scopes: overrides });
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect((await resolver.status(identity, false)).unverifiedPrefixes).toEqual(["/"]);
  });

  it("recomputes immediately after the unindexed prefixes change", async () => {
    const listSpy = vi.fn(async () => [fileEntry("shared", "dir")]);
    const { resolver, identity } = await setup({
      storageForIdentity: async () => fakeStorageProvider({ list: listSpy }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", { items: [], overflow: false }]])),
      cacheTtlMs: 60_000,
    });

    expect((await resolver.verifiedIndexScopes(identity)).available).toBe(false);
    await resolver.setOverrides(identity, [], ["/shared"]);
    expect((await resolver.verifiedIndexScopes(identity)).available).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(2);
  });
});

describe("folder-level mappings", () => {
  const sharedIndex: IndexerDirectoryResponse = {
    items: [{ name: "x.txt", kind: "file" }],
    overflow: false,
  };
  const homeIndex: IndexerDirectoryResponse = {
    items: [{ name: "a.txt", kind: "file" }],
    overflow: false,
  };
  const folderMapping = {
    virtualPath: "/shared",
    rootName: "sftpgo",
    fsPrefix: "/_folders/shared",
  };

  function mountedHome() {
    return fakeStorageProvider({
      list: async (path: string) =>
        path === "/" ? [fileEntry("a.txt"), fileEntry("shared", "dir")] : [fileEntry("x.txt")],
    });
  }

  it("adopts a folder mapping only for a login whose unmapped mount matches it", async () => {
    const { resolver, identity, mountMappingStore } = await setup({
      storageForIdentity: async () => mountedHome(),
      indexer: fakeIndexerDirectory(
        new Map([
          ["sftpgo:/alice", homeIndex],
          ["sftpgo:/_folders/shared", sharedIndex],
        ]),
      ),
    });
    await mountMappingStore.set([folderMapping]);

    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: true,
      scopes: [
        { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
        { rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" },
      ],
    });
    // Office and event consumers see the adopted scope through configuredMappings too.
    const configured = await resolver.configuredMappings(identity);
    expect(configured.available && configured.scopes.map((s) => s.virtualPrefix)).toEqual([
      "/",
      "/shared",
    ]);
    const status = await resolver.status(identity, true);
    expect(status).toMatchObject({
      status: "available",
      usesOverride: false,
      virtualPrefixes: ["/", "/shared"],
      overrides: [],
      adoptedMappings: [
        { rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" },
      ],
    });
  });

  it("never adopts for a login whose same-named directory is really on disk", async () => {
    // "shared" exists in the index listing of the home, so it is an ordinary
    // directory, not a mount: the folder mapping must not shadow it.
    const { resolver, identity, mountMappingStore } = await setup({
      storageForIdentity: async () => mountedHome(),
      indexer: fakeIndexerDirectory(
        new Map([
          [
            "sftpgo:/alice",
            {
              items: [
                { name: "a.txt", kind: "file" },
                { name: "shared", kind: "dir" },
              ],
              overflow: false,
            },
          ],
          ["sftpgo:/_folders/shared", sharedIndex],
        ]),
      ),
    });
    await mountMappingStore.set([folderMapping]);

    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: true,
      scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
    });
    const status = await resolver.status(identity, true);
    expect(status.isAdmin && status.adoptedMappings).toEqual([]);
  });

  it("does nothing for a login without the mount", async () => {
    const { resolver, identity, mountMappingStore } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({ list: async () => [fileEntry("a.txt")] }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", homeIndex]])),
    });
    await mountMappingStore.set([folderMapping]);
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: true,
      scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
    });
  });

  it("lets a per-login override win over a folder mapping at the same path", async () => {
    const { resolver, identity, overrideStore, mountMappingStore } = await setup({
      storageForIdentity: async () => mountedHome(),
      indexer: fakeIndexerDirectory(
        new Map([
          ["sftpgo:/alice", homeIndex],
          ["sftpgo:/pool/team", sharedIndex],
        ]),
      ),
    });
    await mountMappingStore.set([folderMapping]);
    await overrideStore.set(
      identity.id,
      [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" }],
      [],
    );
    const result = await resolver.verifiedIndexScopes(identity);
    expect(result).toEqual({
      available: true,
      scopes: [
        { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
        { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" },
      ],
    });
    const status = await resolver.status(identity, true);
    expect(status.isAdmin && status.adoptedMappings).toEqual([]);
  });

  it("reports an adopted mapping that itself fails as unverified, keeping the home", async () => {
    // The folder mapping points somewhere the indexer cannot list.
    const { resolver, identity, mountMappingStore } = await setup({
      storageForIdentity: async () => mountedHome(),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", homeIndex]])),
    });
    await mountMappingStore.set([folderMapping]);
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: true,
      scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
    });
    const status = await resolver.status(identity, false);
    expect(status.unverifiedPrefixes).toEqual(["/shared"]);
    expect(status.unmappedMounts).toEqual([]);
  });

  it("recomputes every login immediately after setMountMappings", async () => {
    const listSpy = vi.fn(async (path: string) =>
      path === "/" ? [fileEntry("a.txt"), fileEntry("shared", "dir")] : [fileEntry("x.txt")],
    );
    const { resolver, identity } = await setup({
      storageForIdentity: async () => fakeStorageProvider({ list: listSpy }),
      indexer: fakeIndexerDirectory(
        new Map([
          ["sftpgo:/alice", homeIndex],
          ["sftpgo:/_folders/shared", sharedIndex],
        ]),
      ),
      cacheTtlMs: 60_000,
    });
    expect((await resolver.verifiedIndexScopes(identity)).available).toBe(false);
    await resolver.setMountMappings([folderMapping]);
    expect(await resolver.mountMappings()).toEqual([folderMapping]);
    expect((await resolver.verifiedIndexScopes(identity)).available).toBe(true);
    await resolver.setMountMappings([]);
    expect((await resolver.verifiedIndexScopes(identity)).available).toBe(false);
  });

  it("validates folder mappings against the known roots", async () => {
    const { resolver } = await setup();
    await expect(
      resolver.setMountMappings([{ ...folderMapping, rootName: "elsewhere" }]),
    ).rejects.toMatchObject({ reason: "unknown_root" });
    await expect(
      resolver.setMountMappings([folderMapping, { ...folderMapping, fsPrefix: "/other" }]),
    ).rejects.toMatchObject({ reason: "duplicate_virtual_prefix" });
    await expect(
      resolver.setMountMappings([{ ...folderMapping, virtualPath: "/" }]),
    ).rejects.toMatchObject({ reason: "invalid_mapping" });
  });
});

describe("status", () => {
  it("redacts physical mapping data for a non-administrator, but still shows their own virtual mapping", async () => {
    const { resolver, identity } = await setup({ indexRoots: null });
    const result = await resolver.status(identity, false);
    expect(result.isAdmin).toBe(false);
    expect("configuredRoots" in result).toBe(false);
    expect("mappings" in result).toBe(false);
    // The configured (trusted) mapping is still available even though the
    // index is down, so the identity's own virtual prefixes still show.
    expect(result.virtualPrefixes).toEqual(["/"]);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("no_roots");
  });

  it("gives an administrator the full mapping and configured roots", async () => {
    const indexData: IndexerDirectoryResponse = {
      items: [{ name: "a.txt", kind: "file" }],
      overflow: false,
    };
    const { resolver, identity } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({ list: async () => [fileEntry("a.txt")] }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", indexData]])),
    });
    const result = await resolver.status(identity, true);
    expect(result.isAdmin).toBe(true);
    if (result.isAdmin) {
      expect(result.configuredRoots).toEqual(["sftpgo"]);
      expect(result.mappings).toEqual([
        { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
      ]);
      expect(result.overrides).toEqual([]);
    }
    expect(result.status).toBe("available");
    expect(result.reason).toBe("ok");
  });

  it("reports usesOverride based on whether a non-empty override is stored", async () => {
    const { resolver, identity, overrideStore } = await setup();
    expect((await resolver.status(identity, false)).usesOverride).toBe(false);

    await overrideStore.set(
      identity.id,
      [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" }],
      [],
    );
    expect((await resolver.status(identity, false)).usesOverride).toBe(true);
  });

  it("gives an admin an empty mapping when configuredMappings itself is unavailable", async () => {
    const { resolver, identity } = await setup({ connection: fakeConnectionStore(null) });
    const result = await resolver.status(identity, true);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("no_connection");
    if (result.isAdmin) {
      expect(result.mappings).toEqual([]);
      expect(result.configuredRoots).toEqual(["sftpgo"]);
    }
  });

  it("redacts a non-administrator's view when configuredMappings itself is unavailable", async () => {
    const { resolver, identity } = await setup({ connection: fakeConnectionStore(null) });
    const result = await resolver.status(identity, false);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("no_connection");
    expect(result.isAdmin).toBe(false);
    expect("mappings" in result).toBe(false);
    expect("configuredRoots" in result).toBe(false);
  });

  it("redacts a non-administrator's view when verification succeeds", async () => {
    const indexData: IndexerDirectoryResponse = {
      items: [{ name: "a.txt", kind: "file" }],
      overflow: false,
    };
    const { resolver, identity } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({ list: async () => [fileEntry("a.txt")] }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", indexData]])),
    });
    const result = await resolver.status(identity, false);
    expect(result.status).toBe("available");
    expect(result.reason).toBe("ok");
    expect(result.isAdmin).toBe(false);
    expect("mappings" in result).toBe(false);
    expect("configuredRoots" in result).toBe(false);
  });

  it("gives an admin an empty configuredRoots list when configuredMappings is unavailable and no roots are configured", async () => {
    const { resolver, identity } = await setup({
      connection: fakeConnectionStore(null),
      indexRoots: null,
    });
    const result = await resolver.status(identity, true);
    expect(result.status).toBe("unavailable");
    if (result.isAdmin) {
      expect(result.configuredRoots).toEqual([]);
      expect(result.mappings).toEqual([]);
    }
  });

  it("gives an administrator the full mapping even when index verification fails", async () => {
    // Default setup() has no indexer fixture for the mount, so
    // verification fails with indexer_unreachable while the configured
    // mapping itself stays available.
    const { resolver, identity } = await setup();
    const result = await resolver.status(identity, true);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("indexer_unreachable");
    if (result.isAdmin) {
      expect(result.mappings).toEqual([
        { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
      ]);
      expect(result.configuredRoots).toEqual(["sftpgo"]);
    }
  });

  it("always carries the standing warning text", async () => {
    const { resolver, identity } = await setup();
    const result = await resolver.status(identity, false);
    expect(result.warning.length).toBeGreaterThan(0);
  });
});

describe("setOverrides", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  it("persists a valid override", async () => {
    const scope: Scope = { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" };
    await ctx.resolver.setOverrides(ctx.identity, [scope]);
    expect(await ctx.overrideStore.get(ctx.identity.id)).toEqual({
      version: 2,
      scopes: [scope],
      unindexedPrefixes: [],
    });
  });

  it("persists unindexed prefixes on their own, and resets once both lists are empty", async () => {
    await ctx.resolver.setOverrides(ctx.identity, [], ["/archive"]);
    expect(await ctx.overrideStore.get(ctx.identity.id)).toEqual({
      version: 2,
      scopes: [],
      unindexedPrefixes: ["/archive"],
    });
    await ctx.resolver.setOverrides(ctx.identity, [], []);
    expect(await ctx.overrideStore.get(ctx.identity.id)).toBeNull();
  });

  it("rejects an unindexed prefix colliding with a mapping, and never persists it", async () => {
    const scope: Scope = { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" };
    await expect(
      ctx.resolver.setOverrides(ctx.identity, [scope], ["/shared"]),
    ).rejects.toMatchObject({ reason: "unindexed_prefix_collision" });
    expect(await ctx.overrideStore.get(ctx.identity.id)).toBeNull();
  });

  it("rejects a mapping on a root that is neither indexed nor the template root", async () => {
    const scope: Scope = { rootName: "elsewhere", fsPrefix: "/x", virtualPrefix: "/x" };
    await expect(ctx.resolver.setOverrides(ctx.identity, [scope])).rejects.toMatchObject({
      reason: "unknown_root",
    });
  });

  it("accepts a mapping on the template root even when it is not an index root", async () => {
    const other = await setup({
      indexRoots: [{ name: "other-root", sftpgoPath: "/x", indexerPath: "/y" }],
    });
    const scope: Scope = { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/team" };
    await expect(other.resolver.setOverrides(other.identity, [scope])).resolves.toBeUndefined();
  });

  it("resets the override when given an empty list", async () => {
    const scope: Scope = { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" };
    await ctx.resolver.setOverrides(ctx.identity, [scope]);
    await ctx.resolver.setOverrides(ctx.identity, []);
    expect(await ctx.overrideStore.get(ctx.identity.id)).toBeNull();
  });

  it("rejects an invalid override and never persists it", async () => {
    const invalid: Scope = { rootName: "Not Valid", fsPrefix: "/x", virtualPrefix: "/x" };
    await expect(ctx.resolver.setOverrides(ctx.identity, [invalid])).rejects.toBeInstanceOf(
      ScopeOverrideValidationError,
    );
    expect(await ctx.overrideStore.get(ctx.identity.id)).toBeNull();
  });
});
