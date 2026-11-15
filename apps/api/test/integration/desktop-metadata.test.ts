import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopPairing,
  DesktopWriteEntry,
  DesktopWritePairResult,
  type FsEvent,
  GrantsResponse,
  ManagedShare,
  ROUTES,
} from "@fdrive/contracts";
import { createDb, createRepos, type Repos, schema } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
const q = encodeURIComponent;

/**
 * What the Mac's writes do to everything kept by path, through the composed
 * API: a move brings tags, favorites, folder views, folders shared with
 * people, public links and AI chat references along before its commit
 * answers, and tells the browser once; the Mac's Trash keeps tags at the
 * original path for a restore while what grants access follows the item in
 * and back out. What grants access moves with the receipt or the commit is
 * not confirmed; the rest never holds a write back. No indexer runs; the
 * last test sends the move the indexer would report.
 */
describe("metadata follows the Mac's writes as they commit", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let database: ReturnType<typeof createDb>;
  let repos: Repos;
  let stateDir: string;
  let alice: string;
  let bob: string;
  let identityId: string;
  let accountId: string;
  let headers: Record<string, string>;
  const base = "/api/v2/desktop";

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({
        users: ["alice", "bob"].map((username) => ({ username, password: `${username}-pass` })),
        files: {
          alice: {
            "/Project/brief.txt": "brief",
            "/Project/sub/notes.txt": "notes",
            "/Binned/inside.txt": "binned",
            "/Crash/kept.txt": "kept",
            "/Locked/doc.txt": "locked",
            "/next.txt": "next",
          },
          bob: { "/bobs.txt": "bob" },
        },
        grants: [
          { owner: "alice", path: "/Project", grantee: "bob", access: "read" },
          { owner: "alice", path: "/Binned", grantee: "bob", access: "read" },
          { owner: "alice", path: "/Crash", grantee: "bob", access: "read" },
          { owner: "alice", path: "/Locked", grantee: "bob", access: "read" },
        ],
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage, ["alice"]);
    stateDir = await mkdtemp(join(tmpdir(), "fdrive-desktop-metadata-"));
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 23).toString("base64"),
        FDRIVE_DESKTOP_STATE_DIR: stateDir,
        // Configured so the API journals its changes and the indexer listener
        // runs; no indexer does, the last test notifies for it.
        FDRIVE_INDEX_ROOTS: JSON.stringify([
          { name: "files", storagePath: storage.root, indexerPath: "/roots/files" },
        ]),
      }),
      silentLogger(),
    );
    database = createDb(postgres.connectionString);
    repos = createRepos(database.db);
    await database.db.insert(schema.roots).values({ name: "files" }).onConflictDoNothing();
    alice = await login("alice");
    bob = await login("bob");
    headers = await pairMac(alice);
    const owner = (await repos.identities.listAll()).find(
      (identity) => identity.externalUsername === "alice",
    );
    if (owner === undefined) throw new Error("alice has no login");
    identityId = owner.id;
    accountId = owner.accountId;
  }, 180_000);

  afterAll(async () => {
    await composed?.close();
    await database?.close();
    await storage?.stop();
    await postgres?.stop();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }, 180_000);

  async function call(
    path: string,
    options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    return composed.app.request(path, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function ok(response: Promise<Response>): Promise<unknown> {
    const answered = await response;
    const body = await answered.text();
    expect(answered.status, body).toBeLessThan(300);
    return body === "" ? null : JSON.parse(body);
  }

  async function login(username: string): Promise<string> {
    const response = await call(ROUTES.auth.login, {
      body: { username, password: `${username}-pass` },
    });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  /** A full-access Mac pairing for the user whose session `cookie` is. */
  async function pairMac(cookie: string): Promise<Record<string, string>> {
    const pairing = DesktopPairing.parse(
      await ok(call(`${base}/pairings`, { cookie, body: { deviceName: "Metadata" } })),
    );
    await ok(
      call(`/api/v1/desktop/pairings/${pairing.id}/approve`, { cookie, body: { access: "full" } }),
    );
    const pair = DesktopWritePairResult.parse(
      await ok(call(`${base}/pairings/${pairing.id}/poll`, { body: { secret: pairing.secret } })),
    );
    if (pair.status !== "connected") throw new Error("expected connected credentials");
    const credential = pair.credentials[0];
    if (credential === undefined) throw new Error("expected a write credential");
    return { authorization: `Bearer ${credential.token}` };
  }

  const stat = async (path: string) =>
    DesktopWriteEntry.parse(await ok(call(`${base}/entry?path=${q(path)}`, { headers })));

  /** Moves `item` under `parentId` as the Mac does, and returns where it is now. */
  async function macMove(item: DesktopWriteEntry, parentId: string, name = item.name) {
    const operationId = randomUUID();
    await ok(
      call(`${base}/moves`, {
        headers,
        body: { operationId, itemId: item.id, parentId, name, base: item.version },
      }),
    );
    const committed = await ok(
      call(`${base}/operations/${operationId}/commit`, { headers, body: {} }),
    );
    return DesktopWriteEntry.parse((committed as { item: unknown }).item);
  }

  /** Every `fs` event the API streams to `cookie`'s browser from now on. */
  async function stream(cookie: string): Promise<{ events: FsEvent[]; close: () => void }> {
    const controller = new AbortController();
    const response = await composed.app.request(ROUTES.events, {
      headers: { "x-requested-with": "fdrive", cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const events: FsEvent[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 2);
          const data = lines.find((line) => line.startsWith("data:"));
          if (lines.includes("event: fs") && data !== undefined)
            events.push(JSON.parse(data.slice("data:".length)) as FsEvent);
        }
      }
    })().catch(() => undefined);
    return { events, close: () => controller.abort() };
  }

  const grantPaths = async () =>
    GrantsResponse.parse(await ok(call(ROUTES.grants.list, { cookie: alice })))
      .owned.map((grant) => grant.path)
      .sort();
  const sharedWithBob = async () =>
    GrantsResponse.parse(await ok(call(ROUTES.grants.list, { cookie: bob }))).received.map(
      (grant) => grant.name,
    );
  /** A public link alice makes on `path`. */
  const link = async (path: string) =>
    ManagedShare.parse(
      await ok(
        call(ROUTES.shares, {
          cookie: alice,
          body: { name: "Link", paths: [path], scope: "read" },
        }),
      ),
    ).id;
  const linkPaths = async (id: string) =>
    ManagedShare.parse(await ok(call(`${ROUTES.shares}/${id}`, { cookie: alice }))).paths;
  const favorites = async () =>
    (await repos.favorites.list(identityId)).map((favorite) => favorite.path).sort();

  it("brings tags, favorites, folder views, shared folders and chat references along before answering", async () => {
    const tag = await repos.tags.create(accountId, { name: "Work", color: null });
    await repos.fileTags.setTags(identityId, "/Project/brief.txt", [tag.id]);
    await repos.favorites.add(identityId, "/Project", "dir");
    await repos.folderViews.set(identityId, "/Project/sub", { mode: "grid" });
    await repos.recents.touch(identityId, "/Project/sub/notes.txt");
    const chat = await repos.aiChats.create({
      identityId,
      title: "Notes",
      share: { contents: false, otherFileNames: false },
    });
    await repos.aiChats.addReferences(chat.id, ["/Project/sub/notes.txt"]);
    const watching = await stream(alice);
    try {
      const moved = await macMove(await stat("/Project"), "root", "Renamed");
      expect(moved.path).toBe("/Renamed");
      // Nothing waits: every record names the new path once the commit answers.
      expect(await repos.fileTags.pathsForTag(identityId, tag.id)).toEqual(["/Renamed/brief.txt"]);
      expect(await favorites()).toEqual(["/Renamed"]);
      expect(await repos.folderViews.get(identityId, "/Project/sub")).toBeNull();
      expect(await repos.folderViews.get(identityId, "/Renamed/sub")).toMatchObject({
        mode: "grid",
      });
      expect((await repos.recents.list(identityId, 10)).map((recent) => recent.path)).toEqual([
        "/Renamed/sub/notes.txt",
      ]);
      expect(await grantPaths()).toContain("/Renamed");
      expect(await grantPaths()).not.toContain("/Project");
      expect(await repos.aiChats.references(chat.id)).toMatchObject([
        { path: "/Renamed/sub/notes.txt", missing: false },
      ]);
      await expect.poll(() => watching.events.length, { timeout: 5_000 }).toBeGreaterThan(0);
      // Another request through the same app later, the browser still heard of it once.
      await ok(call(ROUTES.grants.list, { cookie: alice }));
      expect(watching.events).toMatchObject([
        { op: "move", identityId, paths: ["/Project"], targetPaths: ["/Renamed"] },
      ]);
      expect(watching.events).toHaveLength(1);
    } finally {
      watching.close();
    }
  });

  it("keeps tags for a restore from the Mac's Trash, while sharing follows the folder in and out", async () => {
    const tag = await repos.tags.create(accountId, { name: "Binned", color: null });
    await repos.fileTags.setTags(identityId, "/Binned/inside.txt", [tag.id]);
    await repos.recents.touch(identityId, "/Binned/inside.txt");
    const folder = await stat("/Binned");
    expect(await sharedWithBob()).toContain("Binned");

    const trashed = await macMove(folder, "trash");
    expect(trashed).toMatchObject({ id: folder.id, parentId: "trash", trashed: true });
    // The handle survives: the Mac finds the item in its Trash under the same ID.
    expect((await stat(trashed.path)).id).toBe(folder.id);
    // Tags stay where the item was and recents go, as before; the share follows
    // the folder out of bob's reach.
    expect(await repos.fileTags.pathsForTag(identityId, tag.id)).toEqual(["/Binned/inside.txt"]);
    expect((await repos.recents.list(identityId, 10)).map((recent) => recent.path)).not.toContain(
      "/Binned/inside.txt",
    );
    expect(await grantPaths()).toContain(`/.fdrive-desktop/${identityId}/trash/${folder.id}`);
    expect(await sharedWithBob()).not.toContain("Binned");

    const back = await macMove(trashed, "root");
    expect(back).toMatchObject({ id: folder.id, path: "/Binned", trashed: false });
    expect(await repos.fileTags.pathsForTag(identityId, tag.id)).toEqual(["/Binned/inside.txt"]);
    expect(await grantPaths()).toContain("/Binned");
    expect(await sharedWithBob()).toContain("Binned");
  });

  it("leaves a commit unconfirmed when sharing cannot move, and resolving it moves sharing", async () => {
    const doc = await link("/Locked/doc.txt");
    const folder = await stat("/Locked");
    await database.pool.query(
      "CREATE FUNCTION app.refuse_locked_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.path = '/Locked' THEN RAISE EXCEPTION 'injected grant outage'; END IF; RETURN NEW; END $$",
    );
    await database.pool.query(
      "CREATE TRIGGER refuse_locked_grant BEFORE UPDATE ON app.local_grants FOR EACH ROW EXECUTE FUNCTION app.refuse_locked_grant()",
    );
    const operationId = randomUUID();
    try {
      await ok(
        call(`${base}/moves`, {
          headers,
          body: {
            operationId,
            itemId: folder.id,
            parentId: "root",
            name: "Unlocked",
            base: folder.version,
          },
        }),
      );
      const commit = await call(`${base}/operations/${operationId}/commit`, { headers, body: {} });
      // Never success: the receipt and the link's move went with the grant's.
      expect(commit.status).toBe(409);
      expect(await commit.json()).toMatchObject({
        error: { details: { code: "operation_uncertain" } },
      });
      expect(await linkPaths(doc)).toEqual(["/Locked/doc.txt"]);
      expect(await grantPaths()).toContain("/Locked");
    } finally {
      await database.pool.query("DROP TRIGGER refuse_locked_grant ON app.local_grants");
      await database.pool.query("DROP FUNCTION app.refuse_locked_grant()");
    }
    // An administrator finds the folder moved and resolves it as published.
    const resolved = await call(`/api/v1/desktop/recovery/${identityId}/${operationId}/resolve`, {
      cookie: alice,
      body: { outcome: "published" },
    });
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    expect(await linkPaths(doc)).toEqual(["/Unlocked/doc.txt"]);
    expect(await grantPaths()).toContain("/Unlocked");
    expect(await grantPaths()).not.toContain("/Locked");
    // Nothing reaches a new folder where the old one was.
    await ok(call(ROUTES.fs.mkdir, { cookie: alice, body: { path: "/Locked" } }));
    expect(await sharedWithBob()).toContain("Unlocked");
    expect(await sharedWithBob()).not.toContain("Locked");
  });

  it("never refuses a later write, and the indexer's report of a move brings metadata along", async () => {
    await repos.favorites.add(identityId, "/Crash", "dir");
    // Metadata cannot follow this move, as if the API stopped right after the rename.
    await database.pool.query(
      "CREATE FUNCTION app.refuse_crash_favorite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.path = '/Crash' THEN RAISE EXCEPTION 'injected metadata outage'; END IF; RETURN NEW; END $$",
    );
    await database.pool.query(
      "CREATE TRIGGER refuse_crash_favorite BEFORE UPDATE ON app.favorites FOR EACH ROW EXECUTE FUNCTION app.refuse_crash_favorite()",
    );
    try {
      expect((await macMove(await stat("/Crash"), "root", "Crashed")).path).toBe("/Crashed");
      expect(await favorites()).toContain("/Crash");
      // The failing favorite never held back the share, which moved with the receipt.
      expect(await grantPaths()).toContain("/Crashed");
      expect(await grantPaths()).not.toContain("/Crash");
      // The next write publishes at once; nothing waits on the metadata that failed.
      expect((await macMove(await stat("/next.txt"), "root", "later.txt")).path).toBe("/later.txt");
    } finally {
      await database.pool.query("DROP TRIGGER refuse_crash_favorite ON app.favorites");
      await database.pool.query("DROP FUNCTION app.refuse_crash_favorite()");
    }
    // The rename is in the change journal, which the indexer reads and reports back.
    await expect
      .poll(async () => {
        const rows = await database.db.execute(
          sql`select source from idx.changes where path = 'alice/Crash' and target_path = 'alice/Crashed'`,
        );
        return rows.rows.map((row) => row.source);
      })
      .toEqual(["api"]);
    await database.db.execute(
      sql`select pg_notify('idx_events', ${JSON.stringify({
        kind: "moved",
        root: "files",
        path: "alice/Crash",
        target_path: "alice/Crashed",
        at: new Date().toISOString(),
      })})`,
    );
    await expect.poll(favorites, { timeout: 10_000 }).toContain("/Crashed");
    expect(await favorites()).not.toContain("/Crash");
  });
});
