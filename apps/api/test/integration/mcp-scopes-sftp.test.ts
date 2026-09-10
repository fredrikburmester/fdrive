import { createDb, createIndexQueries, createRepos, migrate, schema } from "@fdrive/db";
import { createSftpgoClient } from "@fdrive/sftpgo";
import { startPostgres, startSftpgo } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEY_ID, seal } from "../../src/auth/crypto.js";
import { createTokenSource } from "../../src/auth/index.js";
import type { Principal } from "../../src/auth/principal.ts";
import { createIdentityStorageFactory } from "../../src/auth/storage-factory.ts";
import type { IndexRootConfig } from "../../src/config.js";
import {
  runFileInfo,
  runFindDuplicates,
  runFindFiles,
  runFolderOverview,
  runListDirectory,
  runReadFileText,
  runRecentMoves,
} from "../../src/mcp/handlers.ts";
import type { IndexerExtractClient } from "../../src/mcp/indexer-client.ts";
import {
  memoryProviderService,
  seedSftpgoProvider,
} from "../../src/providers/test-fixtures/index.ts";
import { createInMemoryMountMappingStore } from "../../src/scoping/mount-mapping-store.ts";
import { createSettingsScopeOverrideStore } from "../../src/scoping/override-store.ts";
import { createScopeResolver } from "../../src/scoping/resolver.ts";
import { fakeIndexerDirectory } from "../../src/scoping/test-fixtures/index.ts";
import { createSearchService } from "../../src/search/service.ts";

/**
 * Real isolated SFTPGo and Postgres coverage for the MCP tools'
 * scope-and-authorization wiring (`docs/workflow/P5-SCOPE-CONSUMERS.md`'s
 * "MCP chunk"). As in `scopes-sftp.test.ts`, no real indexer container runs:
 * `verifiedIndexScopes`'s directory-verification step uses
 * `fakeIndexerDirectory`, seeded to mirror exactly what the real SFTP
 * listings below produce; the MCP `read_file_text` tool's extraction step
 * similarly uses a small fake `IndexerExtractClient`. Everything else
 * (login, storage reads, scope math, index rows, live read authorization)
 * runs against the real SFTPGo container and a real, migrated Postgres
 * database.
 */
describe("MCP tools against real SFTPGo and Postgres", () => {
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
          // read check must deny every file even though listing and
          // `verifiedIndexScopes` both succeed.
          { username: "reader", password: "reader-pass", permissions: { "/": ["list"] } },
        ],
        folders: [{ name: "shared" }],
        files: {
          alice: {
            "/report.txt": "alice's report",
            "/report-copy.txt": "alice's report",
          },
          reader: { "/notes.txt": "reader's notes" },
          // The shared folder's own physical content (the override's real
          // target), independent of any single user's home.
          "@shared": { "/dup.txt": "alice's report" },
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

  it("filters every MCP tool by verified scope, round trip, and a live read check for two identities and a list-only reader", async () => {
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

    await seedSftpgoProvider(repos, sftp.baseUrl, {
      managedByEnv: true,
      homeTemplate: "sftpgo:/{username}",
    });
    const providers = memoryProviderService(repos, {
      fetch: globalThis.fetch,
      clock,
      sftpgoUrl: sftp.baseUrl,
    });
    const tokenSource = createTokenSource({
      repos,
      providers,
      master,
      clock,
      fetch: globalThis.fetch,
    });
    const storageFactory = createIdentityStorageFactory({
      providers,
      tokenSource,
      fetch: globalThis.fetch,
      clock,
    });

    const indexRoots: IndexRootConfig[] = [
      { name: "sftpgo", sftpgoPath: "/data", indexerPath: "/data" },
    ];
    const indexer = fakeIndexerDirectory(
      new Map([
        [
          "sftpgo:/alice",
          {
            items: [
              { name: "report.txt", kind: "file" as const },
              { name: "report-copy.txt", kind: "file" as const },
              { name: "vshared", kind: "dir" as const },
            ],
            overflow: false,
          },
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

    const scopeResolver = createScopeResolver({
      providers: repos.providers,
      overrides: createSettingsScopeOverrideStore(repos.settings),
      mountMappings: createInMemoryMountMappingStore(),
      indexRoots,
      indexer,
      storageForIdentity: (identity) => storageFactory(identity.id),
      clock,
    });

    // Alice's admin-configured override: "/vshared" maps to the real
    // physical "shared" folder, matching the real SFTPGo virtual folder
    // mounted into her account.
    await scopeResolver.setOverrides(alice, [
      { rootName: "sftpgo", fsPrefix: "/shared", virtualPrefix: "/vshared" },
    ]);

    const aliceVerified = await scopeResolver.verifiedIndexScopes(alice);
    expect(aliceVerified.available).toBe(true);
    const readerVerified = await scopeResolver.verifiedIndexScopes(reader);
    expect(readerVerified.available).toBe(true);

    // Seed index rows: alice's two real, readable files; the shared
    // override's real physical target; a physical file that happens to sit
    // at "alice/vshared/..." (a real subdirectory under alice's own home
    // that nobody set up as a virtual folder), shadowed by the override
    // once it exists; and the list-only reader's one file.
    const [root] = await db.insert(schema.roots).values({ name: "sftpgo" }).returning();
    if (root === undefined) throw new Error("expected the root insert to return a row");
    const now = new Date();
    const REPORT_SHA = "a".repeat(64);
    await db.insert(schema.files).values([
      {
        rootId: root.id,
        path: "alice/report.txt",
        name: "report.txt",
        ext: ".txt",
        size: 15,
        sha256: REPORT_SHA,
        mtimeNs: BigInt(now.getTime()) * 1_000_000n,
        textStatus: "done",
      },
      {
        rootId: root.id,
        path: "alice/report-copy.txt",
        name: "report-copy.txt",
        ext: ".txt",
        size: 15,
        sha256: REPORT_SHA,
        mtimeNs: BigInt(now.getTime()) * 1_000_000n,
        textStatus: "done",
      },
      {
        rootId: root.id,
        path: "shared/dup.txt",
        name: "dup.txt",
        ext: ".txt",
        size: 15,
        sha256: REPORT_SHA,
        mtimeNs: BigInt(now.getTime()) * 1_000_000n,
        textStatus: "done",
      },
      {
        rootId: root.id,
        // A physical location shadowed by the "/vshared" override once it
        // exists: this file is NOT the override's real target, and must
        // never surface under the override's virtual name.
        path: "alice/vshared/dup.txt",
        name: "dup.txt",
        ext: ".txt",
        size: 15,
        sha256: REPORT_SHA,
        mtimeNs: BigInt(now.getTime()) * 1_000_000n,
        textStatus: "done",
      },
      {
        rootId: root.id,
        path: "reader/notes.txt",
        name: "notes.txt",
        ext: ".txt",
        size: 13,
        sha256: REPORT_SHA,
        mtimeNs: BigInt(now.getTime()) * 1_000_000n,
        textStatus: "done",
      },
    ]);
    await db.insert(schema.moves).values([
      // A genuine, live-readable destination: surfaces in recent_moves.
      { rootId: root.id, src: "alice/report.txt", dst: "alice/report-copy.txt", actor: "mcp" },
      // A destination nothing was ever written to: fails the live read
      // check, so this move (and its source) must never be disclosed.
      { rootId: root.id, src: "alice/secret.txt", dst: "alice/never-written.txt", actor: "mcp" },
    ]);

    const indexQueries = createIndexQueries(db);
    const aliceStorage = await storageFactory(alice.id);
    const readerStorage = await storageFactory(reader.id);
    const alicePrincipal: Principal = {
      accountId: aliceAccount.id,
      identityId: alice.id,
      username: "alice",
      storage: aliceStorage,
      isAdmin: false,
    };
    const readerPrincipal: Principal = {
      accountId: readerAccount.id,
      identityId: reader.id,
      username: "reader",
      storage: readerStorage,
      isAdmin: false,
    };

    const extractCalls: string[] = [];
    const indexerClient: IndexerExtractClient = {
      async extract({ root: rootName, path }) {
        extractCalls.push(`${rootName}:${path}`);
        return { text: "extracted text", status: "ok" };
      },
    };

    const toolDeps = {
      indexQueries,
      searchService: createSearchService({
        indexQueries,
        embedClient: null,
        thumbsEnabled: false,
        trashPath: null,
        clock,
      }),
      scopeResolver,
      identities: repos.identities,
      publicUrl: async () => "https://fdrive.example.com",
      indexerClient,
      writesEnabled: false,
      clock,
      trashPath: null,
    };

    // 1. find_files: alice sees her own two real files at their round-
    // tripped virtual paths; the shadowed "alice/vshared/dup.txt" row never
    // surfaces as "/vshared/dup.txt" (or at all), even though it matches
    // every scope predicate at the SQL level.
    const aliceFiles = await runFindFiles(toolDeps, alicePrincipal, {});
    const alicePaths = aliceFiles.results.map((r) => r.path).sort();
    expect(alicePaths).toEqual(["/report-copy.txt", "/report.txt", "/vshared/dup.txt"]);

    // 2. file_info: alice's report has two identical copies: the real
    // "/report-copy.txt" and the override's real target "/vshared/dup.txt";
    // never the shadowed physical location.
    const info = await runFileInfo(toolDeps, alicePrincipal, { path: "/report.txt" });
    expect(info.identical_copies.sort()).toEqual(["/report-copy.txt", "/vshared/dup.txt"]);

    // 3. find_duplicates: the group over sha256 REPORT_SHA keeps only
    // alice's three authorized, round-tripped copies (report.txt,
    // report-copy.txt, the override's dup.txt); the shadowed physical
    // location and the list-only reader's own file (a different scope
    // entirely) never appear.
    const duplicates = await runFindDuplicates(toolDeps, alicePrincipal, { min_size_mb: 0 });
    expect(duplicates.total_groups).toBe(1);
    expect(duplicates.groups[0]?.copies).toBe(3);
    expect([...(duplicates.groups[0]?.paths ?? [])].sort()).toEqual([
      "/report-copy.txt",
      "/report.txt",
      "/vshared/dup.txt",
    ]);

    // 4. folder_overview: bytes are only ever added for round-tripped,
    // read-authorized files; the shadowed row's bytes never inflate the
    // root folder's total.
    const overview = await runFolderOverview(toolDeps, alicePrincipal, {});
    expect(overview.total_files).toBe(3);
    expect(overview.total_bytes).toBe(45);

    // 5. recent_moves: only the move whose destination is a real,
    // live-readable file surfaces; the move to a path nothing was ever
    // written to (and its source) is never disclosed.
    const moves = await runRecentMoves(toolDeps, alicePrincipal, {});
    expect(moves.moves).toEqual([
      { at: expect.any(String), src: "/report.txt", dst: "/report-copy.txt" },
    ]);

    // 6. read_file_text: extraction only ever runs after a live download
    // check passes.
    const text = await runReadFileText(toolDeps, alicePrincipal, { path: "/report.txt" });
    expect(text).toMatchObject({ text: "extracted text" });
    expect(extractCalls).toEqual(["sftpgo:alice/report.txt"]);

    // 7. The list-only reader: verification and native `list_directory`
    // both succeed (an entirely independent SFTP call), but every
    // index-backed tool that would disclose content is denied.
    const readerListing = await runListDirectory(readerPrincipal, {});
    expect(readerListing.entries.map((e) => e.name)).toEqual(["notes.txt"]);

    const readerFiles = await runFindFiles(toolDeps, readerPrincipal, {});
    expect(readerFiles.results).toEqual([]);
    expect(readerFiles.partial).toBe(true);

    await expect(runFileInfo(toolDeps, readerPrincipal, { path: "/notes.txt" })).rejects.toThrow(
      /not indexed/,
    );

    await expect(
      runReadFileText(toolDeps, readerPrincipal, { path: "/notes.txt" }),
    ).rejects.toThrow(/outside this identity's scope/);
    // The live read check denied the file before extraction was ever
    // attempted.
    expect(extractCalls).toEqual(["sftpgo:alice/report.txt"]);
  });
});
