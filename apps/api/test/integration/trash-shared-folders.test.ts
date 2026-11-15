import { existsSync } from "node:fs";
import { FavoritesResponse, ROUTES, TrashListResponse } from "@fdrive/contracts";
import { createDb } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
const SHARED = "/Shared with me/Team";

/**
 * A delete in a folder its owner shares with someone to edit, against real
 * PostgreSQL and a local folder: the file is the owner's, so it goes to the
 * owner's Trash, with what the owner keeps by path; the person it is shared
 * with has nothing of it in their Trash and cannot purge the owner's.
 */
describe("Trash and folders shared with people, against real PostgreSQL and a local folder", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let database: ReturnType<typeof createDb>;

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({
        users: ["alice", "bob"].map((username) => ({ username, password: `${username}-pass` })),
        files: { alice: { "/Team/plan.txt": "plan", "/Team/keep.txt": "keep" } },
        grants: [{ owner: "alice", path: "/Team", grantee: "bob", access: "write" }],
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage);
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 17).toString("base64"),
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

  async function call(path: string, options: { cookie: string; body?: unknown; method?: string }) {
    return composed.app.request(path, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        "x-requested-with": "fdrive",
        cookie: options.cookie,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function login(username: string): Promise<string> {
    const response = await composed.app.request(ROUTES.auth.login, {
      method: "POST",
      headers: { "x-requested-with": "fdrive", "content-type": "application/json" },
      body: JSON.stringify({ username, password: `${username}-pass` }),
    });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  async function trashOf(cookie: string) {
    const response = await call(ROUTES.trash.list, { cookie });
    expect(response.status).toBe(200);
    return TrashListResponse.parse(await response.json()).entries;
  }

  async function favorites(cookie: string): Promise<string[]> {
    const response = await call(ROUTES.favorites.base, { cookie });
    expect(response.status).toBe(200);
    return FavoritesResponse.parse(await response.json()).items.map((item) => item.path);
  }

  it("sends the owner's file to the owner's Trash, with history for both and no purge for the grantee", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    expect(
      (await call(ROUTES.favorites.base, { cookie: alice, body: { path: "/Team/plan.txt" } }))
        .status,
    ).toBe(200);
    expect(
      (await call(ROUTES.favorites.base, { cookie: bob, body: { path: `${SHARED}/plan.txt` } }))
        .status,
    ).toBe(200);

    const deleted = await call(ROUTES.fs.delete, {
      cookie: bob,
      body: { items: [{ path: `${SHARED}/plan.txt`, kind: "file" }] },
    });
    expect(deleted.status).toBe(200);

    // The owner's Trash has it, at the owner's path; the grantee's has nothing.
    expect(await trashOf(bob)).toEqual([]);
    const [entry] = await trashOf(alice);
    expect(entry).toMatchObject({ originalPath: "/Team/plan.txt", name: "plan.txt" });
    if (entry === undefined) throw new Error("expected the file in alice's Trash");
    expect(existsSync(storage.path("alice", "/Team/plan.txt"))).toBe(false);
    expect(existsSync(storage.path("alice", `/.trash/${entry.id}/plan.txt`))).toBe(true);
    expect(existsSync(storage.path("bob", "/.trash"))).toBe(false);
    // What each kept by path left the old path: nothing waits there for a new file.
    expect(await favorites(alice)).toEqual([]);
    expect(await favorites(bob)).toEqual([]);

    // The grantee's history has the trash, at the path they deleted.
    const history = await database.db.execute<{ username: string; path: string; leaf: string }>(sql`
      select i.username, e.after ->> 'path' as path,
        e.after ->> 'trashLeaf' as leaf
      from app.activity_events e join app.identities i on i.id = e.identity_id
      where e.action = 'file.trash' and e.stage = 'outcome'`);
    expect(history.rows).toEqual([
      { username: "bob", path: `${SHARED}/plan.txt`, leaf: `/.trash/${entry.id}/plan.txt` },
    ]);

    // The grantee cannot purge the owner's Trash: their own holds no such item.
    expect(
      (await call(ROUTES.trash.purge, { cookie: bob, body: { ids: [entry.id] } })).status,
    ).toBe(200);
    expect(existsSync(storage.path("alice", `/.trash/${entry.id}/plan.txt`))).toBe(true);

    // The owner restores it: back in the shared folder, with the owner's favorite.
    const restored = await call(ROUTES.trash.restore, {
      cookie: alice,
      body: { ids: [entry.id] },
    });
    expect(restored.status).toBe(200);
    expect(existsSync(storage.path("alice", "/Team/plan.txt"))).toBe(true);
    expect(await favorites(alice)).toEqual(["/Team/plan.txt"]);
    const restoredBy = await database.db.execute<{ username: string }>(sql`
      select i.username from app.activity_events e
        join app.identities i on i.id = e.identity_id
      where e.action = 'file.restore' and e.stage = 'outcome'`);
    expect(restoredBy.rows).toEqual([{ username: "alice" }]);
  }, 120_000);

  it("refuses to let the person it is shared with move the shared folder itself to Trash", async () => {
    const bob = await login("bob");
    const response = await call(ROUTES.fs.delete, {
      cookie: bob,
      body: { items: [{ path: SHARED, kind: "dir" }] },
    });
    expect(response.status).toBe(403);
    expect(existsSync(storage.path("alice", "/Team/keep.txt"))).toBe(true);
  }, 60_000);
});
