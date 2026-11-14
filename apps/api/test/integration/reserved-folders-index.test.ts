import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDb, createIndexQueries, createRepos, migrate, schema } from "@fdrive/db";
import { createLocalModule, type LocalUsers } from "@fdrive/local";
import { startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/principal.ts";
import { createIdentityStorageFactory } from "../../src/auth/storage-factory.ts";
import {
  type McpToolDeps,
  runFileInfo,
  runFindDuplicates,
  runFindFiles,
  runFolderOverview,
  runIndexStats,
  runListDirectory,
  runRecentMoves,
  runSearch,
  runSimilarFiles,
} from "../../src/mcp/handlers.ts";
import { memoryProviderService } from "../../src/providers/test-fixtures/index.ts";
import { createScopeResolver } from "../../src/scoping/resolver.ts";
import { createSearchService } from "../../src/search/service.ts";

const SAME = "a".repeat(64);
/** Live files, oldest first; fdrive's own copies of them are newer, so they would sort first. */
const LIVE = ["report-a.txt", "report-b.txt", "report-c.txt"];
/** fdrive's own places in alice's files, each holding a copy of report-a. */
const RESERVED = [
  ".trash/.fdrive-move-v1/file/p/report-x.txt/v/1",
  ".fdrive-desktop/staging/report-y.txt",
  "Old/.fdrive-move-v1/file/p/report-z.txt/v/2",
];

/** How far each file's content lies from report-a's; fdrive's own copies lie on it. */
const DISTANCE: Readonly<Record<string, number>> = {
  "alice/report-b.txt": 30,
  "alice/report-c.txt": 90,
};

function vector(offset: number): number[] {
  return Array.from({ length: 384 }, (_, i) => (i + offset) / 384);
}

/**
 * The index keeps fdrive's Trash (so moves into and out of it stay renames)
 * and may still hold rows under the Mac app's folder or an old Trash layout;
 * every MCP tool leaves them out in SQL before its limit, so pages are full
 * and totals count only what the tool can return. Rows are inserted by hand.
 */
describe("fdrive's own folders in the index, through the MCP tools", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let database: ReturnType<typeof createDb>;
  let root: string;
  let deps: McpToolDeps;
  let alice: Principal;

  async function put(path: string): Promise<void> {
    const target = join(root, "alice", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "the same report");
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    database = createDb(postgres.connectionString);
    await migrate(database.db);
    root = await mkdtemp(join(tmpdir(), "fdrive-reserved-"));
    for (const path of [...LIVE, ...RESERVED]) await put(path);

    const { db } = database;
    const repos = createRepos(db);
    const clock = () => new Date();
    const users: LocalUsers = {
      verify: async () => ({ result: "invalid" }),
      status: async () => "active",
      shared: async () => [],
    };
    const module = createLocalModule({ root, users, indexRoot: "files" });
    const providers = memoryProviderService(repos, { modules: { local: module } });
    const provider = await repos.providers.ensure({ type: "local", baseUrl: "local" });
    await repos.providers.update(provider.id, { enabled: true, managedByEnv: true });
    const account = await repos.accounts.create({ displayName: "alice" });
    const identity = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "alice",
    });
    const storage = await createIdentityStorageFactory({
      providers,
      fetch: globalThis.fetch,
      clock,
    })(identity.id);

    const [indexRoot] = await db.insert(schema.roots).values({ name: "files" }).returning();
    if (indexRoot === undefined) throw new Error("expected the root insert to return a row");
    const rows = await db
      .insert(schema.files)
      .values(
        [...LIVE, ...RESERVED].map((path, index) => ({
          rootId: indexRoot.id,
          path: `alice/${path}`,
          name: path.slice(path.lastIndexOf("/") + 1),
          ext: ".txt",
          size: 15,
          sha256: path === "report-c.txt" ? "c".repeat(64) : SAME,
          mtimeNs: BigInt(1_700_000_000_000 + index * 1000) * 1_000_000n,
          textStatus: "done" as const,
        })),
      )
      .returning();
    // report-a's nearest neighbours by content are its own copies; report-b comes after them.
    await db.insert(schema.chunks).values(
      rows.map((row) => ({
        fileId: row.id,
        idx: 0,
        text: "the same report",
        embedding: vector(DISTANCE[row.path] ?? 0),
      })),
    );
    const at = (path: string) => `alice/${path}`;
    await db.insert(schema.moves).values([
      { rootId: indexRoot.id, src: at("draft.txt"), dst: at("report-c.txt"), actor: "mcp" },
      { rootId: indexRoot.id, src: at("x.txt"), dst: at(RESERVED[0] as string), actor: "mcp" },
      { rootId: indexRoot.id, src: at(RESERVED[1] as string), dst: at("y.txt"), actor: "mcp" },
    ]);

    const indexQueries = createIndexQueries(db);
    deps = {
      indexQueries,
      searchService: createSearchService({
        indexQueries,
        embedClient: null,
        thumbsEnabled: false,
        clock,
      }),
      scopeResolver: createScopeResolver({ providers, indexRootNames: ["files"] }),
      identities: repos.identities,
      publicUrl: async () => null,
      indexerClient: null,
      writesEnabled: false,
      clock,
      trashPathForStorage: () => "/.trash",
    };
    alice = {
      accountId: account.id,
      identityId: identity.id,
      username: "alice",
      storage,
      isAdmin: false,
    };
  }, 180_000);

  afterAll(async () => {
    await database?.close();
    await postgres?.stop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }, 180_000);

  it("find_files fills each page and counts only the user's files", async () => {
    const first = await runFindFiles(deps, alice, { limit: 2 });
    expect(first.results.map((file) => file.path)).toEqual(["/report-c.txt", "/report-b.txt"]);
    expect(first).toMatchObject({ next_offset: 2, total_matches: 2 });
    const next = await runFindFiles(deps, alice, { limit: 2, offset: 2 });
    expect(next.results.map((file) => file.path)).toEqual(["/report-a.txt"]);
    expect(next).not.toHaveProperty("next_offset");
    expect(next).not.toHaveProperty("partial");
    // A prefix inside fdrive's own folders finds nothing.
    expect((await runFindFiles(deps, alice, { path_prefix: "/.trash" })).results).toEqual([]);
  });

  it("find_duplicates, file_info and similar_files never name a copy in fdrive's own folders", async () => {
    const duplicates = await runFindDuplicates(deps, alice, { min_size_mb: 0, limit: 1 });
    expect(duplicates.groups).toEqual([
      expect.objectContaining({ copies: 2, paths: ["/report-a.txt", "/report-b.txt"] }),
    ]);
    expect(duplicates).not.toHaveProperty("partial");

    const info = await runFileInfo(deps, alice, { path: "/report-a.txt" });
    expect(info.identical_copies).toEqual(["/report-b.txt"]);
    expect(info).not.toHaveProperty("partial");

    const similar = await runSimilarFiles(deps, alice, { path: "/report-a.txt", limit: 1 });
    expect(similar.results.map((file) => file.path)).toEqual(["/report-b.txt"]);
    expect(similar).not.toHaveProperty("partial");
  });

  it("folder_overview, index_stats, search and recent_moves count only the user's files", async () => {
    const overview = await runFolderOverview(deps, alice, {});
    expect(overview).toMatchObject({ total_files: 3, truncated: false });
    expect(overview.folders.map((folder) => folder.path)).toEqual(["/"]);

    const stats = await runIndexStats(deps, alice);
    expect(stats.files_tracked).toBe(3);
    expect(stats).not.toHaveProperty("partial");

    const search = await runSearch(deps, alice, { query: "report", limit: 3 });
    expect(search.results.map((file) => file.path).sort()).toEqual(LIVE.map((name) => `/${name}`));

    const moves = await runRecentMoves(deps, alice, { limit: 1 });
    expect(moves).toEqual({
      moves: [expect.objectContaining({ src: "/draft.txt", dst: "/report-c.txt" })],
    });
  });

  it("list_directory hides fdrive's own folders and refuses to open one", async () => {
    const top = await runListDirectory(deps, alice, {});
    expect(top.entries.map((entry) => entry.name)).toEqual(["Old", ...LIVE]);
    expect((await runListDirectory(deps, alice, { path: "/Old" })).entries).toEqual([]);
    for (const path of ["/.trash", "/.fdrive-desktop/staging", "/Old/.fdrive-move-v1"]) {
      await expect(runListDirectory(deps, alice, { path })).rejects.toThrow("fdrive's own folders");
    }
  });
});
