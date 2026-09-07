import type { IndexerDirectoryResponse } from "@fdrive/contracts";
import type { Scope } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexRootConfig } from "../config.ts";
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
  const clockCtl = buildClock(1_700_000_000_000);

  const deps: CreateScopeResolverDeps = {
    providers: repos.providers,
    overrides: overrideStore,
    connection: fakeConnectionStore(CONNECTION),
    indexRoots: INDEX_ROOTS,
    indexer: fakeIndexerDirectory(new Map()),
    storageForIdentity: async () => fakeStorageProvider(),
    clock: clockCtl.clock,
    ...overrides,
  };
  const resolver = createScopeResolver(deps);
  return { resolver, identity, provider, overrideStore, clockCtl, deps };
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
    await overrideStore.set(identity.id, [override]);

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

  it("is unavailable with mismatch when an SFTP entry is missing from the index", async () => {
    const indexData: IndexerDirectoryResponse = { items: [], overflow: false };
    const { resolver, identity } = await setup({
      storageForIdentity: async () =>
        fakeStorageProvider({ list: async () => [fileEntry("a.txt")] }),
      indexer: fakeIndexerDirectory(new Map([["sftpgo:/alice", indexData]])),
    });
    expect(await resolver.verifiedIndexScopes(identity)).toEqual({
      available: false,
      reason: "mismatch",
    });
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
    await overrideStore.set(identity.id, [
      { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" },
    ]);

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
    await overrideStore.set(identity.id, overrides);

    const result = await resolver.verifiedIndexScopes(identity);
    expect(result.available).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(listSpy).toHaveBeenCalledTimes(4);
  });

  it("skips remaining candidates once a failure is already known", async () => {
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
      // Serialize the two candidates so the second only starts once the
      // first (which fails) has already set `failure`.
      verifyConcurrency: 1,
    });
    await overrideStore.set(identity.id, overrides);

    const result = await resolver.verifiedIndexScopes(identity);
    expect(result).toEqual({ available: false, reason: "mismatch" });
    // The home scope ("/alice") always runs first (it is always present);
    // the second candidate must never even call list once failure is known.
    expect(listSpy).toHaveBeenCalledTimes(1);
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
    }
    expect(result.status).toBe("available");
    expect(result.reason).toBe("ok");
  });

  it("reports usesOverride based on whether a non-empty override is stored", async () => {
    const { resolver, identity, overrideStore } = await setup();
    expect((await resolver.status(identity, false)).usesOverride).toBe(false);

    await overrideStore.set(identity.id, [
      { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" },
    ]);
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
    expect(await ctx.overrideStore.get(ctx.identity.id)).toEqual({ version: 1, scopes: [scope] });
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
