import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { joinPath, parseSearchFilters, type Scope } from "@fdrive/core";
import { createDb, createIndexQueries, createRepos, migrate, schema } from "@fdrive/db";
import {
  createFilesFolder,
  type LocalUsers,
  SHARED_WITH_ME,
  type SharedGrant,
  sharedFolderNames,
} from "@fdrive/local";
import { startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/principal.ts";
import { createIdentityStorageFactory } from "../../src/auth/storage-factory.ts";
import { readFileText } from "../../src/mcp/content.ts";
import {
  fileInfoInScope,
  type McpToolDeps,
  runFindDuplicates,
  runFindFiles,
  runFolderOverview,
} from "../../src/mcp/handlers.ts";
import { resolveScopeContext } from "../../src/mcp/scope-context.ts";
import { createScopeResolver } from "../../src/scoping/resolver.ts";
import { createSearchService } from "../../src/search/service.ts";
import type { TokenPrincipal } from "../../src/tokens/principal.ts";

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

  it("keeps each login to its own home and its shared folders, by its scopes alone", async () => {
    const { db } = database;
    const repos = createRepos(db);
    const clock = () => new Date();
    const grants: Record<string, readonly SharedGrant[]> = {
      alice: [{ owner: "bob", path: "/Photos", writable: false }],
    };
    const users: LocalUsers = {
      status: async () => "active",
      shared: async (username) => grants[username] ?? [],
    };
    const folder = createFilesFolder({ root, users, indexRoot: "files" });
    const row = await repos.providers.ensure({ type: "local", baseUrl: "local" });

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

    const storageFactory = createIdentityStorageFactory({
      identities: repos.identities,
      folder,
      clock,
    });

    const resolver = createScopeResolver({
      storageId: row.id,
      rootName: "files",
      indexRootNames: ["files"],
      extraScopes: async (username, home) => {
        const shared = await users.shared(username);
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

    const aliceScopes = await resolver.verifiedIndexScopes("alice");
    const bobScopes = await resolver.verifiedIndexScopes("bob");
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
      // Indexed, but gone from disk since: listed until the next index pass.
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
    async function search(scopes: readonly Scope[], query: string): Promise<string[]> {
      const result = await searchService.search({
        scopes,
        query,
        filters: parseSearchFilters({}),
        limit: 20,
      });
      return result.sections.files.map((file) => file.path).sort();
    }

    // Same virtual names in two homes: each login finds only its own.
    expect(await search(aliceScopes.scopes, "report")).toEqual(["/report-copy.txt", "/report.txt"]);
    expect(await search(bobScopes.scopes, "report")).toEqual(["/report.txt"]);
    // The shared folder appears under alice's mount, and under bob's own path for bob.
    expect(await search(aliceScopes.scopes, "cat")).toEqual(["/Shared with me/Photos/cat.txt"]);
    expect(await search(bobScopes.scopes, "cat")).toEqual(["/Photos/cat.txt"]);
    // The physical folder the mount shadows never surfaces.
    expect(await search(aliceScopes.scopes, "stale")).toEqual([]);
    // The scope is the permission: a file gone from disk is listed until the
    // next index pass, and opening it answers not found (below).
    expect(await search(aliceScopes.scopes, "gone")).toEqual(["/gone.txt"]);

    const toolDeps: McpToolDeps = {
      indexQueries,
      searchService,
      scopeResolver: resolver,
      publicUrl: async () => null,
      indexerClient: null,
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
      "/gone.txt",
      "/report-copy.txt",
      "/report.txt",
    ]);
    // Bob's report has the same content, but it is outside alice's scopes.
    const ctx = await resolveScopeContext(indexQueries, aliceScopes.scopes);
    if (ctx === null) throw new Error("expected alice's scope context");
    const info = await fileInfoInScope(toolDeps, ctx, { path: "/report.txt" });
    expect(info.identical_copies).toEqual(["/report-copy.txt"]);
    const duplicates = await runFindDuplicates(toolDeps, alicePrincipal, { min_size_mb: 0 });
    expect(duplicates.groups.map((group) => [...group.paths].sort())).toEqual([
      ["/report-copy.txt", "/report.txt"],
    ]);
    const overview = await runFolderOverview(toolDeps, alicePrincipal, {});
    expect(overview.total_files).toBe(4);

    // MCP reads the bytes through alice's own storage, a shared folder included.
    const aliceToken: TokenPrincipal = {
      ...alicePrincipal,
      tokenAccess: { mode: "read", paths: ["/"] },
    };
    expect((await readFileText(toolDeps, aliceToken, { path: "/report.txt" })).text).toBe(
      "the same report",
    );
    expect(
      (await readFileText(toolDeps, aliceToken, { path: "/Shared with me/Photos/cat.txt" })).text,
    ).toBe("meow");
    await expect(readFileText(toolDeps, aliceToken, { path: "/gone.txt" })).rejects.toThrow();
  });
});
