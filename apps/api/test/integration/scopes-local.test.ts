import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { joinPath, parseSearchFilters, type Scope } from "@fdrive/core";
import { createDb, createIndexQueries, createRepos, migrate, schema } from "@fdrive/db";
import {
  createLocalModule,
  type LocalUsers,
  SHARED_WITH_ME,
  type SharedGrant,
  sharedFolderNames,
} from "@fdrive/local";
import { startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenSource } from "../../src/auth/index.js";
import type { Principal } from "../../src/auth/principal.ts";
import { createIdentityStorageFactory } from "../../src/auth/storage-factory.ts";
import {
  type McpToolDeps,
  runFileInfo,
  runFindDuplicates,
  runFindFiles,
  runFolderOverview,
  runReadFileText,
} from "../../src/mcp/handlers.ts";
import type { IndexerExtractClient } from "../../src/mcp/indexer-client.ts";
import { memoryProviderService } from "../../src/providers/test-fixtures/index.ts";
import { createReadAuthorizer } from "../../src/scoping/read-authorizer.ts";
import { createScopeResolver } from "../../src/scoping/resolver.ts";
import { createSearchService } from "../../src/search/service.ts";

/**
 * Index scoping over a real local folder and a real, migrated Postgres
 * (`docs/SCOPING.md`). Two logins have files with the same virtual names;
 * bob shares a folder with alice, which the resolver's extra-scopes hook
 * mounts at `/Shared with me/<name>` exactly where her storage shows it.
 * Index rows are inserted by hand, so no indexer runs.
 */
describe("index scopes over a local folder and Postgres", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let database: ReturnType<typeof createDb>;
  let root: string;

  /** Writes `contents` at `path` under the storage root, creating folders. */
  async function put(path: string, contents: string): Promise<void> {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    database = createDb(postgres.connectionString);
    await migrate(database.db);
    root = await mkdtemp(join(tmpdir(), "fdrive-scopes-"));
    await put("alice/report.txt", "the same report");
    await put("alice/report-copy.txt", "the same report");
    // A real folder in alice's home where her shared folder is mounted: the
    // shared scope shadows it, so its index row must never surface.
    await put(`alice/${SHARED_WITH_ME}/Photos/stale.txt`, "shadowed");
    await put("bob/report.txt", "the same report");
    await put("bob/Photos/cat.txt", "meow");
  }, 180_000);

  afterAll(async () => {
    await database?.close();
    await postgres?.stop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }, 180_000);

  it("keeps each login to its own home and its shared folders, and checks every hit live", async () => {
    const { db } = database;
    const repos = createRepos(db);
    const clock = () => new Date();
    const grants: Record<string, readonly SharedGrant[]> = {
      alice: [{ owner: "bob", path: "/Photos", writable: false }],
    };
    const users: LocalUsers = {
      verify: async () => ({ result: "invalid" }),
      status: async () => "active",
      shared: async (username) => grants[username] ?? [],
    };
    const module = createLocalModule({ root, users, indexRoot: "files" });
    const providers = memoryProviderService(repos, { modules: { local: module } });
    const row = await repos.providers.ensure({ type: "local", baseUrl: "local" });
    await repos.providers.update(row.id, { enabled: true, managedByEnv: true });

    const identities = await Promise.all(
      ["alice", "bob"].map(async (username) => {
        const account = await repos.accounts.create({ displayName: username });
        const identity = await repos.identities.create({
          accountId: account.id,
          providerId: row.id,
          externalUsername: username,
        });
        return { account, identity };
      }),
    );
    const [alice, bob] = identities;
    if (alice === undefined || bob === undefined) throw new Error("expected two identities");

    const tokenSource = createTokenSource({
      repos,
      providers,
      master: Buffer.alloc(32, 3),
      clock,
      fetch: globalThis.fetch,
    });
    const storageFactory = createIdentityStorageFactory({
      providers,
      tokenSource,
      fetch: globalThis.fetch,
      clock,
    });

    const resolver = createScopeResolver({
      providers,
      indexRootNames: ["files"],
      extraScopes: async (identity, home) => {
        const shared = await users.shared(identity.externalUsername);
        const names = sharedFolderNames(shared);
        return shared.map(
          (grant, index): Scope => ({
            rootName: home.rootName,
            fsPrefix: joinPath("/", grant.owner, grant.path),
            virtualPrefix: joinPath("/", SHARED_WITH_ME, names[index] ?? grant.owner),
          }),
        );
      },
    });

    const aliceScopes = await resolver.verifiedIndexScopes(alice.identity);
    const bobScopes = await resolver.verifiedIndexScopes(bob.identity);
    expect(aliceScopes).toEqual({
      available: true,
      scopes: [
        { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" },
        { rootName: "files", fsPrefix: "/bob/Photos", virtualPrefix: "/Shared with me/Photos" },
      ],
    });
    expect(bobScopes).toEqual({
      available: true,
      scopes: [{ rootName: "files", fsPrefix: "/bob", virtualPrefix: "/" }],
    });
    if (!aliceScopes.available || !bobScopes.available) throw new Error("expected scopes");

    const [indexRoot] = await db.insert(schema.roots).values({ name: "files" }).returning();
    if (indexRoot === undefined) throw new Error("expected the root insert to return a row");
    const SHA = "a".repeat(64);
    const mtimeNs = BigInt(Date.now()) * 1_000_000n;
    const row_ = (path: string, size: number, sha256: string | null = SHA) => ({
      rootId: indexRoot.id,
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      ext: ".txt",
      size,
      sha256,
      mtimeNs,
      textStatus: "done" as const,
    });
    await db.insert(schema.files).values([
      row_("alice/report.txt", 15),
      row_("alice/report-copy.txt", 15),
      row_(`alice/${SHARED_WITH_ME}/Photos/stale.txt`, 8, "b".repeat(64)),
      // Indexed, but gone from disk: the live read check drops it.
      row_("alice/gone.txt", 4, "c".repeat(64)),
      row_("bob/report.txt", 15),
      row_("bob/Photos/cat.txt", 4, "d".repeat(64)),
    ]);

    const indexQueries = createIndexQueries(db);
    const searchService = createSearchService({
      indexQueries,
      embedClient: null,
      thumbsEnabled: false,
      clock,
    });
    const aliceStorage = await storageFactory(alice.identity.id);
    const bobStorage = await storageFactory(bob.identity.id);
    async function search(
      scopes: readonly Scope[],
      storage: Principal["storage"],
      query: string,
    ): Promise<string[]> {
      const result = await searchService.search({
        scopes,
        authorizer: createReadAuthorizer({ storage }),
        query,
        filters: parseSearchFilters({}),
        limit: 20,
      });
      return result.sections.files.map((file) => file.path).sort();
    }

    // Same virtual names in two homes: each login finds only its own.
    expect(await search(aliceScopes.scopes, aliceStorage, "report")).toEqual([
      "/report-copy.txt",
      "/report.txt",
    ]);
    expect(await search(bobScopes.scopes, bobStorage, "report")).toEqual(["/report.txt"]);
    // The shared folder appears under alice's mount, and under bob's own path for bob.
    expect(await search(aliceScopes.scopes, aliceStorage, "cat")).toEqual([
      "/Shared with me/Photos/cat.txt",
    ]);
    expect(await search(bobScopes.scopes, bobStorage, "cat")).toEqual(["/Photos/cat.txt"]);
    // The physical folder the mount shadows, and a file gone from disk, never surface.
    expect(await search(aliceScopes.scopes, aliceStorage, "stale")).toEqual([]);
    expect(await search(aliceScopes.scopes, aliceStorage, "gone")).toEqual([]);

    const extractCalls: string[] = [];
    const indexerClient: IndexerExtractClient = {
      async extract({ root: rootName, path }) {
        extractCalls.push(`${rootName}:${path}`);
        return { text: "extracted text", status: "ok" };
      },
    };
    const toolDeps: McpToolDeps = {
      indexQueries,
      searchService,
      scopeResolver: resolver,
      identities: repos.identities,
      publicUrl: async () => null,
      indexerClient,
      writesEnabled: false,
      clock,
    };
    const alicePrincipal: Principal = {
      accountId: alice.account.id,
      identityId: alice.identity.id,
      username: "alice",
      storage: aliceStorage,
      isAdmin: false,
    };

    const files = await runFindFiles(toolDeps, alicePrincipal, {});
    expect(files.results.map((result) => result.path).sort()).toEqual([
      "/Shared with me/Photos/cat.txt",
      "/report-copy.txt",
      "/report.txt",
    ]);
    // Bob's report has the same content, but it is outside alice's scopes.
    const info = await runFileInfo(toolDeps, alicePrincipal, { path: "/report.txt" });
    expect(info.identical_copies).toEqual(["/report-copy.txt"]);
    const duplicates = await runFindDuplicates(toolDeps, alicePrincipal, { min_size_mb: 0 });
    expect(duplicates.groups.map((group) => [...group.paths].sort())).toEqual([
      ["/report-copy.txt", "/report.txt"],
    ]);
    const overview = await runFolderOverview(toolDeps, alicePrincipal, {});
    expect(overview.total_files).toBe(3);

    await runReadFileText(toolDeps, alicePrincipal, { path: "/report.txt" });
    await runReadFileText(toolDeps, alicePrincipal, { path: "/Shared with me/Photos/cat.txt" });
    expect(extractCalls).toEqual(["files:alice/report.txt", "files:bob/Photos/cat.txt"]);
    await expect(
      runReadFileText(toolDeps, alicePrincipal, { path: "/gone.txt" }),
    ).rejects.toThrow();
    expect(extractCalls).toHaveLength(2);
  });
});
