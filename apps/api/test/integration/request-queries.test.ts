import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURES_SETTINGS_KEY, type SearchResponse } from "@fdrive/contracts";
import { createDb, createRepos, INDEX_ROOT_ID, schema } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ComposedApp, composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { generateApiToken, hashApiToken } from "../../src/tokens/token-format.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

/** The statements of the request running in this context; every pooled client reports here. */
const current = new AsyncLocalStorage<string[]>();
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
  const first = args[0];
  current
    .getStore()
    ?.push(typeof first === "string" ? first : String((first as { text?: unknown }).text));
  return (query as (...rest: unknown[]) => unknown).apply(this, args);
} as typeof query;

/** Set to a file path to write every request's statements there. */
const LOG = process.env.FDRIVE_QUERY_LOG;

/** Thirty reports in bob's files: every second one is indexed but gone from disk. */
const REPORTS = Array.from({ length: 30 }, (_, i) => `report-${String(i).padStart(2, "0")}.txt`);
const onDisk = (name: string) => Number(name.slice(7, 9)) % 2 === 0;
const sha = (n: number) => n.toString(16).padStart(64, "0");

/**
 * How many statements a warm server runs for each request a signed-in
 * person makes, as a regression guard: the session and its login are one
 * query, the setup gate, Trash settings, storage name and index root ids are
 * kept in memory, and index results trust the login's scopes instead of
 * probing storage. Over a real Postgres and files folder, through
 * `composeApp`. bob has one folder alice shares with him.
 */
describe("queries per request", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let thumbs: string;
  let composed: ComposedApp;
  const cookies: Record<string, string> = {};
  const bearers: Record<string, string> = {};

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([startPostgres(), startLocalStorage()]);
    await seedLocalUsers(postgres.connectionString, storage);
    thumbs = await mkdtemp(join(tmpdir(), "fdrive-thumbs-"));
    await mkdir(join(thumbs, "aa"), { recursive: true });
    await writeFile(join(thumbs, "aa", "thumb.webp"), "webp bytes");
    await mkdir(join(storage.root, "bob", "reports"));
    for (const name of REPORTS.filter(onDisk)) {
      await writeFile(join(storage.root, "bob", "reports", name), name);
    }
    await writeFile(join(storage.root, "bob", "photo.jpg"), "jpg");
    const database = createDb(postgres.connectionString);
    try {
      const repos = createRepos(database.db);
      await repos.settings.set(FEATURES_SETTINGS_KEY, {
        version: 1,
        revision: 1,
        values: {
          thumbnails: true,
          textSearch: true,
          searchOcr: false,
          semanticSearch: false,
          imageSearch: false,
          pdfOcr: false,
        },
        walkthroughComplete: true,
      });
      const provider = await repos.providers.ensure({ type: "local", baseUrl: "local" });
      await repos.settings.set(`trash.configuration.${provider.id}`, {
        providerId: provider.id,
        revision: 1,
        enabled: true,
        path: "/.trash",
        retentionHours: null,
      });
      const root = { id: INDEX_ROOT_ID };
      const mtimeNs = BigInt(Date.now()) * 1_000_000n;
      const rows: [string, string][] = [
        ["bob/photo.jpg", sha(1000)],
        ["alice/docs/readme.md", sha(1001)],
        ...REPORTS.map((name, i): [string, string] => [`bob/reports/${name}`, sha(i)]),
        // fdrive's own folders, which the index keeps or may still hold.
        ["bob/.trash/trashedthing.txt", sha(2000)],
        ["bob/.fdrive-desktop/staging/stagedthing.txt", sha(2001)],
        ["bob/old/.fdrive-move-v1/file/p/movedthing.txt/v/1", sha(2002)],
      ];
      await database.db.insert(schema.files).values(
        rows.map(([path, key]) => ({
          rootId: root.id,
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          ext: path.slice(path.lastIndexOf(".")),
          size: 10,
          sha256: key,
          mtimeNs,
          textStatus: "done" as const,
        })),
      );
      await database.db
        .insert(schema.thumbnails)
        .values(
          rows.map(([, key]) => ({ contentKey: key, size: 256, storagePath: "aa/thumb.webp" })),
        );
      for (const identity of await repos.identities.listAll()) {
        bearers[identity.externalUsername] = generateApiToken();
        await repos.apiTokens.create({
          accountId: identity.accountId,
          identityId: identity.id,
          name: "query counts",
          tokenHash: hashApiToken(bearers[identity.externalUsername] ?? ""),
          expiresAt: null,
          access: { mode: "read", paths: ["/"] },
        });
      }
    } finally {
      await database.close();
    }

    const config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      FDRIVE_STORAGE_ROOT: storage.root,
      FDRIVE_THUMBS_DIR: thumbs,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
      // Search and thumbnails need the indexer configured; nothing answers here,
      // so search runs without the name index.
      FDRIVE_INDEXER_URL: "http://127.0.0.1:9",
    });
    composed = await composeApp(config, silentLogger(), () => new Date());
    for (const username of ["alice", "bob", "carol"]) {
      const login = await composed.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
        body: JSON.stringify({ username, password: `${username}-password` }),
      });
      expect(login.status).toBe(200);
      cookies[username] = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    }
  }, 180_000);

  afterAll(async () => {
    await composed?.close();
    await postgres?.stop();
    await storage?.stop();
    if (thumbs !== undefined) await rm(thumbs, { recursive: true, force: true });
  }, 180_000);

  /** Sends one request and returns its status, body and the statements it ran. */
  async function send(
    path: string,
    init: { as?: string; bearer?: string; method?: string; body?: unknown } = {},
  ): Promise<{ status: number; text: string; statements: string[] }> {
    const statements: string[] = [];
    const headers: Record<string, string> = {
      "x-requested-with": "fdrive",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(init.bearer === undefined
        ? { cookie: cookies[init.as ?? "bob"] ?? "" }
        : { authorization: `Bearer ${init.bearer}` }),
    };
    const { status, text } = await current.run(statements, async () => {
      const response = await composed.app.request(path, {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      return { status: response.status, text: await response.text() };
    });
    if (LOG !== undefined) {
      await appendFile(
        LOG,
        `${path} ${status} ${statements.length}\n  ${statements.join("\n  ")}\n`,
      );
    }
    return { status, text, statements };
  }

  const thumb = (path: string) => `/api/v1/thumb?path=${encodeURIComponent(path)}&size=256`;
  const searchFor = async (q: string, as = "bob") =>
    JSON.parse((await send(`/api/v1/search?q=${q}&limit=20`, { as })).text) as SearchResponse;
  const mcpList = {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  };

  it("resolves a signed-in request in one query and keeps index results to a few", async () => {
    // One statement resolves the request; the rest are the handler's own: the
    // login and the feature settings (whether the files folder is indexed)
    // for /auth/me; the shares `/Shared with me` lists, tags and
    // favorites for a listing; the grants, feature settings, the three
    // index queries, the hits and one thumbnail lookup for search; the
    // grants, feature settings, the file and its thumbnail for a tile.
    // On main before this change: 12, 12, 30, 15 and 17.
    const budgets = {
      "/api/v1/auth/me": 3,
      "/api/v1/fs/list?path=/": 4,
      "/api/v1/search?q=report&limit=20": 8,
      [thumb("/photo.jpg")]: 5,
      [thumb("/Shared with me/docs/readme.md")]: 5,
    };
    // Warm the pool and what a running server keeps in memory.
    for (const path of Object.keys(budgets)) await send(path);
    await send("/mcp", { bearer: bearers.bob ?? "", ...mcpList });

    for (const [path, budget] of Object.entries(budgets)) {
      const { status, statements } = await send(path);
      expect(status, path).toBe(200);
      expect(statements.length, `${path}:\n${statements.join("\n")}`).toBeLessThanOrEqual(budget);
    }
    // A token is resolved the same way: one query for the token and its login
    // (main: 6).
    const token = await send("/mcp", { bearer: bearers.bob ?? "", ...mcpList });
    expect(token.status).toBe(200);
    expect(token.statements, token.statements.join("\n")).toHaveLength(1);
  });

  it("fills a search page from the index alone, and never shows fdrive's own folders", async () => {
    const found = await searchFor("report");
    // Twenty of thirty reports, half of them gone from disk since they were indexed.
    expect(found.sections.files).toHaveLength(20);
    expect(found.sections.files.every((hit) => hit.path.startsWith("/reports/"))).toBe(true);
    expect(found.sections.files.every((hit) => hit.hasThumbnail)).toBe(true);
    for (const name of ["trashedthing", "stagedthing", "movedthing"]) {
      expect((await searchFor(name)).sections.files).toEqual([]);
    }
    for (const path of [
      "/.trash/trashedthing.txt",
      "/.fdrive-desktop/staging/stagedthing.txt",
      "/old/.fdrive-move-v1/file/p/movedthing.txt/v/1",
    ]) {
      expect((await send(thumb(path))).status, path).toBe(404);
    }
    // One gone from disk is listed until the next index pass, and not found when opened.
    expect((await send("/api/v1/fs/download?path=/reports/report-01.txt")).status).toBe(404);
  });

  it("stops showing a folder in search and thumbnails as soon as its share is revoked", async () => {
    expect((await searchFor("readme")).sections.files.map((hit) => hit.path)).toEqual([
      "/Shared with me/docs/readme.md",
    ]);
    expect((await send(thumb("/Shared with me/docs/readme.md"))).status).toBe(200);

    const grants = JSON.parse((await send("/api/v1/grants", { as: "alice" })).text) as {
      owned: { id: string; username: string }[];
    };
    const toBob = grants.owned.find((grant) => grant.username === "bob");
    if (toBob === undefined) throw new Error("expected alice's share with bob");
    expect(
      (await send(`/api/v1/grants/${toBob.id}`, { as: "alice", method: "DELETE" })).status,
    ).toBeLessThan(300);

    expect((await searchFor("readme")).sections.files).toEqual([]);
    expect((await send(thumb("/Shared with me/docs/readme.md"))).status).toBe(404);
  });

  it("refuses a disabled user's session and token on their next request", async () => {
    const database = createDb(postgres.connectionString);
    const disabled = (value: boolean) =>
      database.pool.query("update app.local_users set disabled = $1 where username = 'carol'", [
        value,
      ]);
    try {
      expect((await send("/api/v1/auth/me", { as: "carol" })).status).toBe(200);
      expect((await send("/mcp", { bearer: bearers.carol ?? "", ...mcpList })).status).toBe(200);

      // Disabled straight in the database, so nothing ended the session.
      await disabled(true);
      expect((await send("/api/v1/auth/me", { as: "carol" })).status).toBe(403);
      expect((await send("/api/v1/fs/list?path=/", { as: "carol" })).status).toBe(403);
      expect((await send("/mcp", { bearer: bearers.carol ?? "", ...mcpList })).status).toBe(403);

      await disabled(false);
      expect((await send("/api/v1/auth/me", { as: "carol" })).status).toBe(200);
    } finally {
      await database.close();
    }
  });
});
