import type { ApiTokenAccess } from "@fdrive/contracts";
import { ROUTES } from "@fdrive/contracts";
import { createDb, createRepos } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { generateApiToken, hashApiToken } from "../../src/tokens/token-format.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

/**
 * `recent_moves` reads personal activity: the moves the token's own login made
 * through MCP, within the token's folders. Another account's moves, and the
 * login's own moves made anywhere but MCP, are never listed.
 */
describe("MCP recent_moves from personal activity", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let database: ReturnType<typeof createDb>;
  let requestId = 0;

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({
        users: ["alice", "bob"].map((username) => ({ username, password: `${username}-pass` })),
        files: {
          alice: { "/a.txt": "a", "/web.txt": "web", "/Narrow/x.txt": "x" },
          bob: { "/a.txt": "bob's a" },
        },
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage);
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 35).toString("base64"),
      }),
      silentLogger(),
    );
    database = createDb(postgres.connectionString);
  }, 180_000);

  afterAll(async () => {
    await composed?.close();
    await database?.close();
    await storage?.stop();
    await postgres?.stop();
  }, 180_000);

  async function login(username: string): Promise<string> {
    const response = await composed.app.request(ROUTES.auth.login, {
      method: "POST",
      headers: { "x-requested-with": "fdrive", "content-type": "application/json" },
      body: JSON.stringify({ username, password: `${username}-pass` }),
    });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  }

  /** A token for `username`'s login. */
  async function token(username: string, access: ApiTokenAccess): Promise<string> {
    const repos = createRepos(database.db);
    const identity = (await repos.identities.listAll()).find((row) => row.username === username);
    if (identity === undefined) throw new Error(`expected ${username}'s login`);
    const raw = generateApiToken();
    await repos.apiTokens.create({
      accountId: identity.accountId,
      identityId: identity.id,
      name: `${username} ${access.mode}`,
      tokenHash: hashApiToken(raw),
      expiresAt: null,
      access,
    });
    return raw;
  }

  async function tool(bearer: string, name: string, args: Record<string, unknown>) {
    const response = await composed.app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(body.result.isError, body.result.content[0]?.text).not.toBe(true);
    return JSON.parse(body.result.content[0]?.text ?? "null");
  }

  it("lists the caller's own MCP moves within its folders, never another account's", async () => {
    const aliceCookie = await login("alice");
    await login("bob");
    const alice = await token("alice", { mode: "organize", paths: ["/"] });
    const aliceNarrow = await token("alice", { mode: "organize", paths: ["/Narrow"] });
    const bob = await token("bob", { mode: "organize", paths: ["/"] });

    await tool(alice, "move_path", { src: "/a.txt", dst: "/b.txt" });
    await tool(bob, "move_path", { src: "/a.txt", dst: "/c.txt" });
    await tool(aliceNarrow, "move_path", { src: "/Narrow/x.txt", dst: "/Narrow/y.txt" });
    // Alice's own move in the browser is hers too, but not one MCP made.
    const web = await composed.app.request(ROUTES.fs.move, {
      method: "POST",
      headers: {
        "x-requested-with": "fdrive",
        "content-type": "application/json",
        cookie: aliceCookie,
      },
      body: JSON.stringify({ path: "/web.txt", target: "/web-moved.txt" }),
    });
    expect(web.status, await web.text()).toBeLessThan(300);

    const at = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);
    expect(await tool(alice, "recent_moves", {})).toEqual({
      moves: [
        { at, src: "/Narrow/x.txt", dst: "/Narrow/y.txt" },
        { at, src: "/a.txt", dst: "/b.txt" },
      ],
    });
    expect(await tool(alice, "recent_moves", { limit: 1 })).toEqual({
      moves: [{ at, src: "/Narrow/x.txt", dst: "/Narrow/y.txt" }],
    });
    expect(await tool(aliceNarrow, "recent_moves", {})).toEqual({
      moves: [{ at, src: "/Narrow/x.txt", dst: "/Narrow/y.txt" }],
    });
    expect(await tool(bob, "recent_moves", {})).toEqual({
      moves: [{ at, src: "/a.txt", dst: "/c.txt" }],
    });
  });
});
