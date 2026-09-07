import { parseSearchFilters } from "@fdrive/core";
import { createDb, createIndexQueries, createRepos, migrate, schema } from "@fdrive/db";
import { createSftpgoClient } from "@fdrive/sftpgo";
import { startPostgres, startSftpgo } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEY_ID, seal } from "../../src/auth/crypto.js";
import { createTokenSource } from "../../src/auth/index.js";
import { createIdentityClientResolver } from "../../src/auth/provider-client.ts";
import { createIdentityStorageFactory } from "../../src/auth/storage-factory.ts";
import type { IndexRootConfig } from "../../src/config.js";
import { createConnectionStore } from "../../src/connection/store.js";
import {
  createInMemoryScopeOverrideStore,
  createSettingsScopeOverrideStore,
} from "../../src/scoping/override-store.ts";
import { createReadAuthorizer } from "../../src/scoping/read-authorizer.ts";
import { createScopeResolver } from "../../src/scoping/resolver.ts";
import { fakeIndexerDirectory } from "../../src/scoping/test-fixtures/index.ts";
import { createSearchService } from "../../src/search/service.ts";

/**
 * Real isolated SFTPGo integration coverage for the scope engine's HTTP
 * consumers (`docs/workflow/P5-SCOPE-CONSUMERS.md`). This does not run a
 * real indexer container: the resolver's directory-verification step is
 * exercised against `fakeIndexerDirectory`, seeded to mirror exactly what
 * the real SFTP listings below produce, which the chunk spec explicitly
 * allows ("if a real indexer is impractical, use the fake directory
 * client"). Everything else (login, storage reads, scope math, search
 * filtering) runs against the real SFTPGo container and a real, migrated
 * Postgres database.
 */
describe("scope engine against real SFTPGo and Postgres", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let sftp: Awaited<ReturnType<typeof startSftpgo>>;
  let database: ReturnType<typeof createDb>;

  beforeAll(async () => {
    [postgres, sftp] = await Promise.all([
      startPostgres(),
      startSftpgo({
        users: [
          {
            username: "alice",
            password: "alice-pass",
            permissions: { "/": ["*"] },
            // A real SFTPGo virtual folder, mapped at "/vshared": this is
            // what the scope override below mirrors, so a live read check
            // through it is a genuine SFTP round trip, not a stub.
            virtualFolders: [{ name: "shared", virtualPath: "/vshared" }],
          },
          // A list-only identity: `list` but never `download`, so a live
          // read check must deny every file even though listing succeeds.
          { username: "reader", password: "reader-pass", permissions: { "/": ["list"] } },
        ],
        folders: [{ name: "shared" }],
        files: {
          alice: { "/report.txt": "alice's report" },
          reader: { "/notes.txt": "reader's notes" },
          // Seeds the "shared" folder's own physical content (see
          // `seedFileLayout`'s "@shared" convention), independent of any
          // single user's home.
          "@shared": { "/dup.txt": "the shared, override-target copy" },
        },
      }),
    ]);
    database = createDb(postgres.connectionString);
    await migrate(database.db);
  }, 180_000);

  afterAll(async () => {
    await database?.close();
    await sftp?.stop();
    await postgres?.stop();
  }, 180_000);

  it("verifies scopes, filters shadowed same-name files, denies a list-only reader's content, and applies an admin override immediately", async () => {
    const { db } = database;
    const repos = createRepos(db);
    const clock = () => new Date();
    const master = Buffer.alloc(32, 3);

    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: sftp.baseUrl });
    const aliceAccount = await repos.accounts.create({ displayName: "Alice" });
    const alice = await repos.identities.create({
      accountId: aliceAccount.id,
      providerId: provider.id,
      externalUsername: "alice",
    });
    const readerAccount = await repos.accounts.create({ displayName: "Reader" });
    const reader = await repos.identities.create({
      accountId: readerAccount.id,
      providerId: provider.id,
      externalUsername: "reader",
    });
    // Stores each identity's real SFTPGo password sealed under `master`, the
    // same shape the login flow persists, so `storageFactory` below can
    // mint tokens against the real container on demand.
    await repos.credentials.put({
      identityId: alice.id,
      ciphertext: seal(
        master,
        new TextEncoder().encode(JSON.stringify({ password: "alice-pass" })),
        alice.id,
      ),
      keyId: KEY_ID,
    });
    await repos.credentials.put({
      identityId: reader.id,
      ciphertext: seal(
        master,
        new TextEncoder().encode(JSON.stringify({ password: "reader-pass" })),
        reader.id,
      ),
      keyId: KEY_ID,
    });

    const connectionStore = createConnectionStore({
      settings: repos.settings,
      envUrl: sftp.baseUrl,
      defaultHomeTemplate: "sftpgo:/{username}",
      clock,
    });
    const clientForBaseUrl = () =>
      createSftpgoClient({ baseUrl: sftp.baseUrl, fetch: globalThis.fetch });
    const clientForIdentity = createIdentityClientResolver({
      identities: repos.identities,
      providers: repos.providers,
      connections: connectionStore,
      clientForBaseUrl,
    });
    const tokenSource = createTokenSource({ repos, master, clock, clientForIdentity });
    const storageFactory = createIdentityStorageFactory({ clientForIdentity, tokenSource });

    const indexRoots: IndexRootConfig[] = [
      { name: "sftpgo", sftpgoPath: "/data", indexerPath: "/data" },
    ];

    // Mirrors exactly what real SFTP listings below produce for each
    // in-scope virtual path (see the comment on the describe block above).
    const indexer = fakeIndexerDirectory(
      new Map([
        [
          "sftpgo:/alice",
          { items: [{ name: "report.txt", kind: "file" as const }], overflow: false },
        ],
        [
          "sftpgo:/shared",
          { items: [{ name: "dup.txt", kind: "file" as const }], overflow: false },
        ],
        [
          "sftpgo:/reader",
          { items: [{ name: "notes.txt", kind: "file" as const }], overflow: false },
        ],
      ]),
    );

    const resolver = createScopeResolver({
      providers: repos.providers,
      overrides: createSettingsScopeOverrideStore(repos.settings),
      connection: connectionStore,
      indexRoots,
      indexer,
      storageForIdentity: (identity) => storageFactory(identity.id),
      clock,
    });

    // 1. Alice's SFTPGo account already has the real "/vshared" virtual
    // folder mounted (an administrator-controlled SFTPGo-level assignment,
    // independent of fdrive's own override state); with no matching fdrive
    // override yet, that extra SFTP-visible entry is unaccounted for by the
    // index, so home-only verification correctly reports a mismatch rather
    // than silently granting access to an unmapped mount. Plain storage
    // access is entirely unaffected (checked directly in step 2 below).
    const aliceHomeOnly = await resolver.verifiedIndexScopes(alice);
    expect(aliceHomeOnly).toEqual({ available: false, reason: "mismatch" });

    // An identity with no extra virtual folder mounts verifies cleanly.
    const readerVerified = await resolver.verifiedIndexScopes(reader);
    expect(readerVerified.available).toBe(true);

    // 2. Wrong template: storage login still works (this is a genuinely
    // independent SFTP call, unrelated to the template), but every
    // index-backed feature is denied because the physical prefix the wrong
    // template computes was never indexed.
    const wrongTemplateResolver = createScopeResolver({
      providers: repos.providers,
      overrides: createInMemoryScopeOverrideStore(),
      connection: createConnectionStore({
        settings: repos.settings,
        envUrl: sftp.baseUrl,
        defaultHomeTemplate: "sftpgo:/wrong/{username}",
        clock,
      }),
      indexRoots,
      indexer,
      storageForIdentity: (identity) => storageFactory(identity.id),
      clock,
    });
    const storage = await storageFactory(alice.id);
    await expect(storage.statFile("/report.txt")).resolves.toMatchObject({ size: 14 });
    const wrongTemplateVerified = await wrongTemplateResolver.verifiedIndexScopes(alice);
    expect(wrongTemplateVerified.available).toBe(false);

    // 3. Admin sets a virtual-folder override for alice: "/vshared" maps to
    // the physical "shared" root, exactly matching the real SFTPGo virtual
    // folder mapped into her account.
    await expect(
      resolver.setOverrides(alice, [
        { rootName: "sftpgo", fsPrefix: "/shared", virtualPrefix: "/vshared" },
      ]),
    ).resolves.toBeUndefined();

    // The override is visible on the very next call: no stale cache entry.
    const afterOverride = await resolver.verifiedIndexScopes(alice);
    expect(afterOverride.available).toBe(true);
    if (!afterOverride.available) throw new Error("expected available");
    expect(afterOverride.scopes).toEqual([
      { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
      { rootName: "sftpgo", fsPrefix: "/shared", virtualPrefix: "/vshared" },
    ]);

    // 4. Seed index rows: one under alice's own home at the exact physical
    // location the override's virtual name now shadows ("alice/vshared/..",
    // which nobody can reach once the override exists), and one at the
    // override's real physical target (the shared folder), both named
    // "dup.txt" so a filename search would find both rows if scope
    // filtering did not exclude the shadowed one.
    const [root] = await db.insert(schema.roots).values({ name: "sftpgo" }).returning();
    if (root === undefined) throw new Error("expected the root insert to return a row");
    const now = new Date();
    await db.insert(schema.files).values([
      {
        rootId: root.id,
        path: "alice/vshared/dup.txt",
        name: "dup.txt",
        ext: ".txt",
        size: 4,
        mtimeNs: BigInt(now.getTime()) * 1_000_000n,
        textStatus: "done",
      },
      {
        rootId: root.id,
        path: "shared/dup.txt",
        name: "dup.txt",
        ext: ".txt",
        size: 4,
        mtimeNs: BigInt(now.getTime()) * 1_000_000n,
        textStatus: "done",
      },
      {
        rootId: root.id,
        path: "reader/notes.txt",
        name: "notes.txt",
        ext: ".txt",
        size: 5,
        mtimeNs: BigInt(now.getTime()) * 1_000_000n,
        textStatus: "done",
      },
    ]);

    const indexQueries = createIndexQueries(db);
    const searchService = createSearchService({
      indexQueries,
      embedClient: null,
      thumbsEnabled: false,
      trashPath: null,
      clock,
    });

    // 5. Alice's search for "dup" finds only the override's real, live
    // target; the shadowed row at the same virtual path never surfaces
    // even though the raw SQL query matches both rows.
    const aliceStorage = await storageFactory(alice.id);
    const dupResult = await searchService.search({
      scopes: afterOverride.scopes,
      authorizer: createReadAuthorizer({ storage: aliceStorage }),
      query: "dup",
      filters: parseSearchFilters({}),
      limit: 20,
    });
    expect(dupResult.sections.files).toHaveLength(1);
    expect(dupResult.sections.files[0]?.path).toBe("/vshared/dup.txt");

    // 6. A list-only reader can list her own home (verification above
    // succeeded) but the live-read check denies every file: she gets no
    // hits, and therefore no snippets or thumbnails, even though the row
    // is squarely inside her own scope and matches the query.
    const readerStorage = await storageFactory(reader.id);
    const notesResult = await searchService.search({
      scopes: readerVerified.available ? readerVerified.scopes : [],
      authorizer: createReadAuthorizer({ storage: readerStorage }),
      query: "notes",
      filters: parseSearchFilters({}),
      limit: 20,
    });
    expect(notesResult.sections.files).toEqual([]);
    expect(notesResult.sections.content).toEqual([]);

    // Directly confirms the denial reason: listing succeeds (per
    // `verifiedIndexScopes` above), but a content read is refused.
    const readerAuthorizer = createReadAuthorizer({ storage: readerStorage });
    await expect(
      readerAuthorizer.authorize({ path: "/notes.txt", kind: "file" }),
    ).resolves.toMatchObject({ allowed: false });
  });
});
