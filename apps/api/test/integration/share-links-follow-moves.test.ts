import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DesktopPairing,
  DesktopWriteEntry,
  DesktopWritePairResult,
  ManagedShare,
  MeResponse,
  publicShareRoute,
  ROUTES,
} from "@fdrive/contracts";
import { createDb, createRepos, schema } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { generateApiToken, hashApiToken } from "../../src/tokens/token-format.js";
import { trashSettingsKey } from "../../src/trash/settings.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
const SHELF = "/Shared with me";
const q = encodeURIComponent;

/**
 * A public link keeps paths in its owner's files. These follow the item on
 * every route fdrive learns of a move: its own file routes and Trash, MCP,
 * the Mac's writes and the indexer's reports of changes made outside fdrive.
 * A link follows its item into the Trash too, where it is not served, and
 * back out on a restore; it never stays behind at a path where something
 * new could appear, so it never serves what its owner did not share.
 */
describe("public links follow the files they point at", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let database: ReturnType<typeof createDb>;
  let stateDir: string;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({
        users: ["alice", "bob"].map((username) => ({ username, password: `${username}-pass` })),
        files: {
          alice: {
            "/Projects/brief.txt": "brief",
            "/Docs/plan.txt": "the plan",
            "/a/three.txt": "in a",
            "/ab/two.txt": "in ab",
            "/Multi/one.txt": "one",
            "/Other/two.txt": "two",
            "/Deep/inner/file.txt": "deep",
            "/Binned/inside.txt": "binned",
            "/Elsewhere/kept.txt": "kept",
            "/Team/brief.txt": "team brief",
            "/Team/sub/notes.txt": "notes",
            "/Mcp/report.txt": "report",
            "/Outside/seen.txt": "seen",
            "/OutsideTrash/x.txt": "x",
            "/Gone/x.txt": "x",
            "/mac.txt": "mac",
            "/MacFolder/inside.txt": "mac inside",
            "/mac-trash.txt": "mac trash",
          },
          bob: { "/mine.txt": "bob's own", "/bobs/keep.txt": "keep" },
        },
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage);
    stateDir = await mkdtemp(join(tmpdir(), "fdrive-share-moves-"));
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 31).toString("base64"),
        FDRIVE_MCP_WRITES: "true",
        FDRIVE_DESKTOP_STATE_DIR: stateDir,
        // Configured so the indexer listener runs; no indexer does, the tests notify for it.
        FDRIVE_INDEX_ROOTS: JSON.stringify([
          { name: "files", storagePath: storage.root, indexerPath: "/roots/files" },
        ]),
      }),
      silentLogger(),
    );
    database = createDb(postgres.connectionString);
    const repos = createRepos(database.db);
    const provider = await repos.providers.ensure({ type: "local", baseUrl: "local" });
    await repos.settings.set(trashSettingsKey(provider.id), {
      providerId: provider.id,
      revision: 1,
      enabled: true,
      path: "/.trash",
      retentionHours: null,
    });
    alice = await login("alice");
    bob = await login("bob");
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
    options: {
      method?: string;
      cookie?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    return composed.app.request(path, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function login(username: string): Promise<string> {
    const response = await call(ROUTES.auth.login, {
      body: { credential: { username, password: `${username}-pass` } },
    });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  async function ok(response: Promise<Response>): Promise<unknown> {
    const answered = await response;
    const body = await answered.text();
    expect(answered.status, body).toBeLessThan(300);
    return body === "" ? null : JSON.parse(body);
  }

  /** A read link on `paths`, made by the user whose session `cookie` is. */
  async function link(cookie: string, ...paths: string[]): Promise<string> {
    const body = await ok(
      call(ROUTES.shares, { cookie, body: { name: "Link", paths, scope: "read" } }),
    );
    return ManagedShare.parse(body).id;
  }

  async function linkPaths(cookie: string, id: string): Promise<string[]> {
    return ManagedShare.parse(await ok(call(`${ROUTES.shares}/${id}`, { cookie }))).paths;
  }

  /** The owner's view of a link: `404` once it is gone. */
  async function linkStatus(cookie: string, id: string): Promise<number> {
    return (await call(`${ROUTES.shares}/${id}`, { cookie })).status;
  }

  /** Writes a new file, the way something new appears where a linked item was. */
  async function put(cookie: string, path: string, content: string): Promise<void> {
    const response = await composed.app.request(
      `${ROUTES.fs.upload}?path=${q(path)}&mkdirParents=true`,
      { method: "PUT", headers: { "x-requested-with": "fdrive", cookie }, body: content },
    );
    expect(response.status, await response.clone().text()).toBe(201);
  }

  /** Every way a visitor could read through a folder or file link. */
  async function served(id: string, child = "/"): Promise<number[]> {
    return Promise.all(
      [
        publicShareRoute(id),
        `${publicShareRoute(id, "entries")}?path=${q("/")}`,
        `${publicShareRoute(id, "download")}?path=${q(child)}`,
      ].map(async (path) => (await call(path)).status),
    );
  }

  /** What a visitor gets: the metadata status, which stats a single shared path. */
  async function visit(id: string): Promise<number> {
    return (await call(publicShareRoute(id))).status;
  }

  async function downloadText(id: string): Promise<string> {
    const response = await call(`${publicShareRoute(id, "download")}?path=${q("/")}`);
    expect(response.status).toBe(200);
    return response.text();
  }

  const move = (cookie: string, path: string, target: string) =>
    ok(call(ROUTES.fs.move, { cookie, body: { path, target } }));
  const renameIn = (cookie: string, path: string, newName: string) =>
    ok(call(ROUTES.fs.rename, { cookie, body: { path, newName } }));

  it("follows the owner's renames and moves of a shared folder, a shared file and a folder above one", async () => {
    const folder = await link(alice, "/Projects");
    const file = await link(alice, "/Docs/plan.txt");
    const nested = await link(alice, "/Deep/inner/file.txt");

    await renameIn(alice, "/Projects", "Work");
    await move(alice, "/Docs/plan.txt", "/Elsewhere/plan.txt");
    await move(alice, "/Deep", "/Elsewhere/Deep");

    expect(await linkPaths(alice, folder)).toEqual(["/Work"]);
    expect(await visit(folder)).toBe(200);
    const entries = await ok(call(`${publicShareRoute(folder, "entries")}?path=${q("/")}`));
    expect(entries).toMatchObject({ items: [{ name: "brief.txt" }] });
    expect(await linkPaths(alice, file)).toEqual(["/Elsewhere/plan.txt"]);
    expect(await downloadText(file)).toBe("the plan");
    expect(await linkPaths(alice, nested)).toEqual(["/Elsewhere/Deep/inner/file.txt"]);
    expect(await downloadText(nested)).toBe("deep");
  });

  it("rewrites only the moved path and what is inside it, in every path of a share", async () => {
    const sibling = await link(alice, "/ab/two.txt");
    const multi = await link(alice, "/Multi/one.txt", "/Other/two.txt", "/a/three.txt");

    await renameIn(alice, "/a", "c");
    await renameIn(alice, "/Multi", "Moved");

    expect(await linkPaths(alice, sibling)).toEqual(["/ab/two.txt"]);
    expect(await downloadText(sibling)).toBe("in ab");
    expect(await linkPaths(alice, multi)).toEqual([
      "/Moved/one.txt",
      "/Other/two.txt",
      "/c/three.txt",
    ]);
    expect((await call(publicShareRoute(multi, "archive"))).status).toBe(200);
  });

  it("follows its item into the Trash and back, and never serves what takes its place", async () => {
    const id = await link(alice, "/Binned");
    const trash = (path: string) =>
      ok(call(ROUTES.fs.delete, { cookie: alice, body: { items: [{ path, kind: "dir" }] } }));
    /** The Trash entry the link followed its folder to. */
    const trashId = async () => {
      const [path] = await linkPaths(alice, id);
      if (!path?.startsWith("/.trash/")) throw new Error(`expected the link in the Trash: ${path}`);
      return path.slice("/.trash/".length);
    };

    await trash("/Binned");
    expect(await visit(id)).toBe(404);
    // Something new of the same name is not what the link was made for.
    await put(alice, "/Binned/new.txt", "never shared");
    expect(await served(id, "/new.txt")).toEqual([404, 404, 404]);

    // Restored to its place, once that is free again, the link works again.
    await move(alice, "/Binned", "/NotBinned");
    await ok(call(ROUTES.trash.restore, { cookie: alice, body: { ids: [await trashId()] } }));
    expect(await linkPaths(alice, id)).toEqual(["/Binned"]);
    expect(await ok(call(`${publicShareRoute(id, "entries")}?path=${q("/")}`))).toMatchObject({
      items: [{ name: "inside.txt" }],
    });

    // Restored somewhere else, the link goes with it.
    await trash("/Binned");
    await ok(
      call(ROUTES.trash.restore, {
        cookie: alice,
        body: { ids: [await trashId()], target: "/Recovered/Binned" },
      }),
    );
    expect(await linkPaths(alice, id)).toEqual(["/Recovered/Binned"]);
    expect(await visit(id)).toBe(200);

    // Purged for good: the link keeps the Trash path, never the original one.
    await trash("/Recovered/Binned");
    const purged = await trashId();
    await ok(call(ROUTES.trash.purge, { cookie: alice, body: { ids: [purged] } }));
    await put(alice, "/Recovered/Binned/new.txt", "a replacement");
    expect(await linkPaths(alice, id)).toEqual([`/.trash/${purged}`]);
    expect(await served(id, "/new.txt")).toEqual([404, 404, 404]);
  });

  it("follows moves inside a writable shared folder, but never out of its owner's files or into Shared with me", async () => {
    await ok(
      call(ROUTES.grants.list, {
        cookie: alice,
        body: { path: "/Team", username: "bob", access: "write" },
      }),
    );
    const brief = await link(alice, "/Team/brief.txt");
    const sub = await link(alice, "/Team/sub");
    const bobs = await link(bob, "/mine.txt");

    // bob renames alice's file where she shares it with him: her link follows.
    await renameIn(bob, `${SHELF}/Team/brief.txt`, "brief-v2.txt");
    expect(await linkPaths(alice, brief)).toEqual(["/Team/brief-v2.txt"]);
    expect(await downloadText(brief)).toBe("team brief");

    // bob takes a folder out into his own files: gone from hers, so her link goes, and
    // a new folder there is served by nobody.
    await move(bob, `${SHELF}/Team/sub`, "/bobs/sub");
    expect(await linkStatus(alice, sub)).toBe(404);
    await put(alice, "/Team/sub/new.txt", "never shared");
    expect(await visit(sub)).toBe(404);

    // bob moves his own linked file into alice's folder: his link follows it under
    // Shared with me, where no link reaches, and serves no new file at its old path.
    await move(bob, "/mine.txt", `${SHELF}/Team/mine.txt`);
    expect(await linkPaths(bob, bobs)).toEqual([`${SHELF}/Team/mine.txt`]);
    await put(bob, "/mine.txt", "never shared");
    expect(await served(bobs)).toEqual([404, 404, 404]);
  });

  it("follows moves, trashes and restores made through MCP", async () => {
    const id = await link(alice, "/Mcp/report.txt");
    const repos = createRepos(database.db);
    const identity = (await repos.identities.listAll()).find(
      (row) => row.externalUsername === "alice",
    );
    if (identity === undefined) throw new Error("expected alice's login");
    const token = generateApiToken();
    await repos.apiTokens.create({
      accountId: identity.accountId,
      identityId: identity.id,
      name: "Share moves",
      tokenHash: hashApiToken(token),
      expiresAt: null,
      access: { mode: "full", paths: ["/"] },
    });
    let requestId = 0;
    const tool = async (name: string, args: Record<string, unknown>) => {
      const response = await composed.app.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
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
      const result = await response.text();
      expect(result, name).not.toContain('"isError":true');
    };

    await tool("move_path", { src: "/Mcp", dst: "/Reports" });
    expect(await linkPaths(alice, id)).toEqual(["/Reports/report.txt"]);
    expect(await downloadText(id)).toBe("report");

    await tool("trash_path", { path: "/Reports" });
    const [trashed] = await linkPaths(alice, id);
    expect(trashed).toMatch(/^\/\.trash\/.+\/report\.txt$/);
    await put(alice, "/Reports/report.txt", "never shared");
    expect(await visit(id)).toBe(404);
    await ok(
      call(ROUTES.fs.delete, {
        cookie: alice,
        body: { items: [{ path: "/Reports", kind: "dir" }] },
      }),
    );
    const entry = (trashed as string).slice("/.trash/".length, -"/report.txt".length);
    await tool("restore_path", { id: entry });
    expect(await linkPaths(alice, id)).toEqual(["/Reports/report.txt"]);
    expect(await downloadText(id)).toBe("report");
  });

  it("follows outside moves the indexer reports, into the Trash too, and lets a deleted item's link go", async () => {
    const seen = await link(alice, "/Outside/seen.txt");
    const binned = await link(alice, "/OutsideTrash");
    const gone = await link(alice, "/Gone/x.txt");
    await database.db.insert(schema.roots).values({ name: "files" }).onConflictDoNothing();
    const onDisk = (path: string) => storage.path("alice", path);
    const notify = (kind: string, path: string, target: string | null = null) =>
      database.db.execute(
        sql`select pg_notify('idx_events', ${JSON.stringify({
          kind,
          root: "files",
          path: `alice/${path}`,
          target_path: target === null ? null : `alice/${target}`,
          at: new Date().toISOString(),
        })})`,
      );

    const trashLeaf = `.trash/.fdrive-move-v1/${randomUUID()}`;
    await mkdir(dirname(onDisk(`/${trashLeaf}`)), { recursive: true });
    await rename(onDisk("/OutsideTrash"), onDisk(`/${trashLeaf}`));
    await notify("moved", "OutsideTrash", trashLeaf);
    await rm(onDisk("/Gone"), { recursive: true });
    await notify("deleted", "Gone");
    // Events apply in order: once the last has, so have the others.
    await rename(onDisk("/Outside"), onDisk("/Seen"));
    await notify("moved", "Outside", "Seen");

    await vi.waitFor(async () => expect(await linkPaths(alice, seen)).toEqual(["/Seen/seen.txt"]), {
      timeout: 10_000,
      interval: 100,
    });
    expect(await downloadText(seen)).toBe("seen");
    expect(await linkPaths(alice, binned)).toEqual([`/${trashLeaf}`]);
    expect(await visit(binned)).toBe(404);
    expect(await linkStatus(alice, gone)).toBe(404);
    await put(alice, "/OutsideTrash/x.txt", "never shared");
    await put(alice, "/Gone/x.txt", "never shared");
    expect(await served(binned, "/x.txt")).toEqual([404, 404, 404]);
    expect(await visit(gone)).toBe(404);
  });

  it("follows the Mac's moves through its metadata recovery, into its Trash and back", async () => {
    const file = await link(alice, "/mac.txt");
    const folder = await link(alice, "/MacFolder/inside.txt");
    const trashed = await link(alice, "/mac-trash.txt");

    const loggedIn = await call(ROUTES.auth.login, {
      body: { credential: { username: "alice", password: "alice-pass" } },
    });
    const cookie = cookieFrom(loggedIn);
    const me = MeResponse.parse(await loggedIn.json());
    const base = "/api/v2/desktop";
    const pairing = DesktopPairing.parse(
      await ok(call(`${base}/pairings`, { cookie, body: { deviceName: "Share moves" } })),
    );
    await ok(
      call(`/api/v1/desktop/pairings/${pairing.id}/approve`, {
        cookie,
        body: {
          identityIds: me.identities.map((identity) => identity.id),
          access: Object.fromEntries(me.identities.map((identity) => [identity.id, "full"])),
        },
      }),
    );
    const pair = DesktopWritePairResult.parse(
      await ok(call(`${base}/pairings/${pairing.id}/poll`, { body: { secret: pairing.secret } })),
    );
    if (pair.status !== "connected") throw new Error("expected connected credentials");
    const credential = pair.credentials[0];
    if (credential === undefined) throw new Error("expected a write credential");
    const headers = { authorization: `Bearer ${credential.token}` };
    const stat = async (path: string) =>
      DesktopWriteEntry.parse(await ok(call(`${base}/entry?path=${q(path)}`, { headers })));
    const macMove = async (
      item: ReturnType<typeof DesktopWriteEntry.parse>,
      parentId: string,
      name: string,
    ) => {
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
    };

    await macMove(await stat("/mac.txt"), "root", "mac-renamed.txt");
    await macMove(await stat("/MacFolder"), "root", "MacMoved");
    const inTrash = await macMove(await stat("/mac-trash.txt"), "trash", "mac-trash.txt");

    await vi.waitFor(
      async () => {
        expect(await linkPaths(alice, file)).toEqual(["/mac-renamed.txt"]);
        expect(await linkPaths(alice, folder)).toEqual(["/MacMoved/inside.txt"]);
        expect((await linkPaths(alice, trashed))[0]).toMatch(/^\/\.fdrive-desktop\//);
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(await downloadText(file)).toBe("mac");
    expect(await downloadText(folder)).toBe("mac inside");
    await put(alice, "/mac-trash.txt", "never shared");
    expect(await visit(trashed)).toBe(404);

    // Put back from the Mac's Trash, under a new name since its place is taken.
    await macMove(inTrash, "root", "mac-back.txt");
    await vi.waitFor(
      async () => expect(await linkPaths(alice, trashed)).toEqual(["/mac-back.txt"]),
      { timeout: 15_000, interval: 100 },
    );
    expect(await downloadText(trashed)).toBe("mac trash");
  });
});
