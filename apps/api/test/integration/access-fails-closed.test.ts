import { GrantsResponse, ManagedShare, publicShareRoute, ROUTES } from "@fdrive/contracts";
import type { IndexQueries } from "@fdrive/db";
import {
  createAccessRepo,
  createDb,
  createRepos,
  createShareRepo,
  createTrashItemRepo,
} from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChatActionTools } from "../../src/ai/chat/action-tools.js";
import type { Principal } from "../../src/auth/principal.js";
import { createIdentityStorageFactory } from "../../src/auth/storage-factory.js";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { createAccessFollowers } from "../../src/files/access.js";
import { createFileOperations, type FileOperations } from "../../src/files/operations.js";
import { deploymentFilesFolder } from "../../src/local/files-folder.js";
import { createLocalGrantService } from "../../src/local/grants.js";
import type { McpToolDeps } from "../../src/mcp/handlers.js";
import { createMetadataService } from "../../src/metadata/service.js";
import { createShareMoves } from "../../src/shares/moves.js";
import { generateApiToken, hashApiToken } from "../../src/tokens/token-format.js";
import { createTrashItems } from "../../src/trash/items.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
const q = encodeURIComponent;

/**
 * What grants access (public links, folders shared with people, Office
 * files) changes in one transaction with each file operation's storage call.
 * When the database refuses that change, the operation fails and nothing
 * stays at a path it vacated: a move leaves the file where it was, and an
 * item put in Trash comes back out. Every caller fails the same way: the
 * web, MCP and AI chat. And a new item made at a path being vacated waits
 * for what granted access there to have gone, so it is never shared.
 */
describe("what grants access fails closed", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let database: ReturnType<typeof createDb>;
  let operations: ReturnType<typeof createDb>;
  let config: ReturnType<typeof loadConfig>;
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
            "/Mcp/report.txt": "report",
            "/McpBin/old.txt": "old",
            "/Ai/notes.txt": "notes",
            "/AiBin/old.txt": "old",
            "/Race/inside.txt": "inside",
            "/Stall/kept.txt": "kept",
          },
          bob: {},
        },
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage);
    config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      FDRIVE_STORAGE_ROOT: storage.root,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 41).toString("base64"),
    });
    composed = await composeApp(config, silentLogger());
    database = createDb(postgres.connectionString);
    operations = createDb(postgres.connectionString, { max: 4 });
    // The database refuses changes to links and shares with people on demand,
    // as one that lost its connection or its disk would.
    await database.db.execute(sql`
      create table public.access_failures (refuse boolean not null);
      create function public.refuse_access() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from public.access_failures where refuse) then
          raise exception 'injected access failure';
        end if;
        return coalesce(new, old);
      end $$;
      create trigger refuse_shares before update or delete on app.shares
        for each row execute function public.refuse_access();
      create trigger refuse_grants before update or delete on app.local_grants
        for each row execute function public.refuse_access();
    `);
    alice = await login("alice");
    bob = await login("bob");
  }, 180_000);

  afterAll(async () => {
    await composed?.close();
    await operations?.close();
    await database?.close();
    await storage?.stop();
    await postgres?.stop();
  }, 180_000);

  async function refusing<T>(work: () => Promise<T>): Promise<T> {
    await database.db.execute(sql`insert into public.access_failures values (true)`);
    try {
      return await work();
    } finally {
      await database.db.execute(sql`delete from public.access_failures`);
    }
  }

  async function call(path: string, options: { cookie?: string; body?: unknown } = {}) {
    return composed.app.request(path, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function login(username: string): Promise<string> {
    const response = await call(ROUTES.auth.login, {
      body: { username, password: `${username}-pass` },
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

  async function link(path: string): Promise<string> {
    const body = await ok(
      call(ROUTES.shares, { cookie: alice, body: { name: "Link", paths: [path], scope: "read" } }),
    );
    return ManagedShare.parse(body).id;
  }

  async function linkPaths(id: string): Promise<string[]> {
    return ManagedShare.parse(await ok(call(`${ROUTES.shares}/${id}`, { cookie: alice }))).paths;
  }

  /** What a visitor finds in a folder link. */
  async function entries(id: string): Promise<string[]> {
    const response = await call(`${publicShareRoute(id, "entries")}?path=${q("/")}`);
    if (response.status !== 200) return [];
    return ((await response.json()) as { items: { name: string }[] }).items.map(
      (item) => item.name,
    );
  }

  async function exists(path: string): Promise<boolean> {
    return (await call(`${ROUTES.fs.stat}?path=${q(path)}`, { cookie: alice })).status === 200;
  }

  async function sharedWithBob(): Promise<string[]> {
    const listed = GrantsResponse.parse(await ok(call(ROUTES.grants.list, { cookie: alice })));
    return listed.owned.map((grant) => grant.path);
  }

  async function mkdir(path: string) {
    await ok(call(ROUTES.fs.mkdir, { cookie: alice, body: { path } }));
  }

  it("fails a web rename the database refuses to follow, then follows it, never sharing a new folder there", async () => {
    const id = await link("/Projects");
    await ok(
      call(ROUTES.grants.list, {
        cookie: alice,
        body: { path: "/Projects", username: "bob", access: "read" },
      }),
    );

    const refused = await refusing(() =>
      call(ROUTES.fs.rename, { cookie: alice, body: { path: "/Projects", newName: "Work" } }),
    );
    expect(refused.status).toBe(500);
    // Nothing moved: the folder, its link and its share are all where they were.
    expect(await exists("/Projects")).toBe(true);
    expect(await exists("/Work")).toBe(false);
    expect(await linkPaths(id)).toEqual(["/Projects"]);
    expect(await sharedWithBob()).toEqual(["/Projects"]);

    await ok(
      call(ROUTES.fs.rename, { cookie: alice, body: { path: "/Projects", newName: "Work" } }),
    );
    expect(await linkPaths(id)).toEqual(["/Work"]);
    expect(await sharedWithBob()).toEqual(["/Work"]);
    // A new folder where the shared one was is shared with nobody.
    await mkdir("/Projects");
    await ok(
      Promise.resolve(
        composed.app.request(`${ROUTES.fs.upload}?path=${q("/Projects/private.txt")}`, {
          method: "PUT",
          headers: { "x-requested-with": "fdrive", cookie: alice },
          body: "private",
        }),
      ),
    );
    expect(await entries(id)).toEqual(["brief.txt"]);
    const shelf = (await ok(
      call(`${ROUTES.fs.list}?path=${q("/Shared with me")}`, { cookie: bob }),
    )) as { entries: { name: string }[] };
    expect(shelf.entries.map((entry) => entry.name)).toEqual(["Work"]);
  });

  it("leaves an item where it was when the database refuses to move its link into Trash", async () => {
    const id = await link("/Docs");
    const refused = await refusing(() =>
      call(ROUTES.fs.delete, { cookie: alice, body: { items: [{ path: "/Docs", kind: "dir" }] } }),
    );
    expect(refused.status).toBe(500);
    expect(await exists("/Docs/plan.txt")).toBe(true);
    expect(await linkPaths(id)).toEqual(["/Docs"]);
    const trash = (await ok(call(ROUTES.trash.list, { cookie: alice }))) as { entries: unknown[] };
    expect(trash.entries).toEqual([]);
  });

  it("fails MCP's moves and trashes the same way", async () => {
    const moved = await link("/Mcp/report.txt");
    const binned = await link("/McpBin");
    const repos = createRepos(database.db);
    const identity = (await repos.identities.listAll()).find((row) => row.username === "alice");
    if (identity === undefined) throw new Error("expected alice's login");
    const token = generateApiToken();
    await repos.apiTokens.create({
      accountId: identity.accountId,
      identityId: identity.id,
      name: "Fails closed",
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
      return response.text();
    };

    await refusing(async () => {
      expect(await tool("move_path", { src: "/Mcp/report.txt", dst: "/Mcp/moved.txt" })).toContain(
        '"isError":true',
      );
      expect(await tool("trash_path", { path: "/McpBin" })).toContain('"isError":true');
    });
    expect(await exists("/Mcp/report.txt")).toBe(true);
    expect(await exists("/Mcp/moved.txt")).toBe(false);
    expect(await exists("/McpBin/old.txt")).toBe(true);
    expect(await linkPaths(moved)).toEqual(["/Mcp/report.txt"]);
    expect(await linkPaths(binned)).toEqual(["/McpBin"]);

    expect(
      await tool("move_path", { src: "/Mcp/report.txt", dst: "/Mcp/moved.txt" }),
    ).not.toContain('"isError":true');
    expect(await linkPaths(moved)).toEqual(["/Mcp/moved.txt"]);
  });

  /** The file operations as `composition.ts` builds them, over this database. */
  async function fileOperations(
    pool = operations,
  ): Promise<{ files: FileOperations; alice: Principal }> {
    const repos = createRepos(database.db);
    const storageFor = createIdentityStorageFactory({
      identities: repos.identities,
      folder: deploymentFilesFolder(config, repos),
    });
    const grants = createLocalGrantService({ repos, storageFor });
    const access = createAccessFollowers({
      repo: createAccessRepo(pool.db),
      ownerPath: grants.ownerPath,
      links: createShareMoves({ ownerPath: grants.ownerPath }).resolve,
      usernameOf: async (identityId) => (await repos.identities.get(identityId))?.username ?? null,
    });
    const files = createFileOperations({
      access,
      metadata: createMetadataService(repos),
      ownerPath: grants.ownerPath,
      trash: createTrashItems({
        repo: createTrashItemRepo(database.db),
        access,
        homeOf: storageFor,
      }),
    });
    const identity = (await repos.identities.listAll()).find((row) => row.username === "alice");
    if (identity === undefined) throw new Error("expected alice's login");
    return {
      files,
      alice: {
        accountId: identity.accountId,
        identityId: identity.id,
        username: "alice",
        isAdmin: false,
        storage: await storageFor(identity.id),
      },
    };
  }

  it("fails AI chat's moves and trashes the same way", async () => {
    const moved = await link("/Ai/notes.txt");
    const binned = await link("/AiBin");
    const { files, alice: principal } = await fileOperations();
    const tools = createChatActionTools({
      files,
      principal,
      mcp: {
        indexQueries: {} as IndexQueries,
        searchService: {} as McpToolDeps["searchService"],
        scopeResolver: { scopesFor: async () => [] },
        indexed: async () => false,
        publicUrl: async () => null,
        indexerClient: null,
        clock: () => new Date(),
      },
      focus: {
        paths: new Set(["/Ai/notes.txt", "/AiBin"]),
        adjective: "referenced",
        group: "the references",
        openFolders: true,
      },
      indexed: false,
      conversationId: "323e4567-e89b-42d3-a456-426614174000",
    });
    const tool = (name: string) => {
      const found = tools.find((candidate) => candidate.spec.name === name);
      if (found === undefined) throw new Error(`no tool ${name}`);
      return found;
    };
    const signal = new AbortController().signal;
    const rename = tool("rename_items");
    const renaming = await rename.verify(
      rename.schema.parse({
        summary: "s",
        renames: [{ path: "/Ai/notes.txt", name: "renamed.txt", reason: "r" }],
      }),
      signal,
    );
    const trash = tool("trash_items");
    const trashing = await trash.verify(
      trash.schema.parse({ summary: "s", items: [{ path: "/AiBin", reason: "r" }] }),
      signal,
    );

    await refusing(async () => {
      await expect(rename.apply(renaming, undefined, signal)).rejects.toThrow();
      await expect(trash.apply(trashing, undefined, signal)).rejects.toThrow();
    });
    expect(await exists("/Ai/notes.txt")).toBe(true);
    expect(await exists("/AiBin/old.txt")).toBe(true);
    expect(await linkPaths(moved)).toEqual(["/Ai/notes.txt"]);
    expect(await linkPaths(binned)).toEqual(["/AiBin"]);

    expect((await rename.apply(renaming, undefined, signal)).outcome).toBe("Renamed 1 item.");
    expect(await linkPaths(moved)).toEqual(["/Ai/renamed.txt"]);
  });

  it("makes a new folder at a path being vacated wait until what granted access there has gone", async () => {
    const id = await link("/Race");
    const { files, alice: principal } = await fileOperations();
    const shares = createShareRepo(database.db);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let onDisk!: () => void;
    const movedOnDisk = new Promise<void>((resolve) => {
      onDisk = resolve;
    });
    // The rename is on disk, its transaction not yet committed.
    const pausing = {
      ...principal.storage,
      move: async (...args: Parameters<Principal["storage"]["move"]>) => {
        const moved = await principal.storage.move(...args);
        onDisk();
        await paused;
        return moved;
      },
    };
    const moving = files.move(
      { identityId: principal.identityId, storage: pausing, recorded: null },
      "/Race",
      "/Raced",
    );
    await movedOnDisk;
    let sharedWhenCreated: readonly string[] | undefined;
    const creating = files
      .mkdir(
        { identityId: principal.identityId, storage: principal.storage, recorded: null },
        "/Race",
      )
      .then(async () => {
        sharedWhenCreated = (await shares.get(id))?.paths;
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sharedWhenCreated).toBeUndefined();
    release();
    await Promise.all([moving, creating]);
    expect(sharedWhenCreated).toEqual(["/Raced"]);
    expect(await entries(id)).toEqual(["inside.txt"]);
  });

  it("holds no transaction or lock while an upload's body stalls", async () => {
    // One connection for every file operation: one held by the stalled
    // upload would stop every write below.
    const single = createDb(postgres.connectionString, { max: 1, connectionTimeoutMillis: 5_000 });
    try {
      const { files, alice: principal } = await fileOperations(single);
      const actor = {
        identityId: principal.identityId,
        storage: principal.storage,
        recorded: null,
      };
      let arrive!: () => void;
      let reading!: () => void;
      const started = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("slow "));
        },
        async pull(controller) {
          reading();
          await new Promise<void>((resolve) => {
            arrive = resolve;
          });
          controller.enqueue(new TextEncoder().encode("save"));
          controller.close();
        },
      });
      const slow = files.upload(actor, "/Stall/same.txt", stalled, {
        action: "file.save",
        overwrite: true,
      });
      await started;
      // Another write to the same path, and to others, go on while it stalls.
      await files.upload(actor, "/Stall/same.txt", new TextEncoder().encode("first"), {
        action: "file.create",
      });
      await files.upload(actor, "/Stall/other.txt", new TextEncoder().encode("other"), {
        action: "file.create",
      });
      await files.mkdir(actor, "/Stall/folder");
      await files.move(actor, "/Stall/kept.txt", "/Stall/folder/kept.txt");
      const read = async (path: string) =>
        new Response((await principal.storage.download(path)).body).text();
      expect(await read("/Stall/same.txt")).toBe("first");
      arrive();
      await slow;
      expect(await read("/Stall/same.txt")).toBe("slow save");
      expect(await read("/Stall/folder/kept.txt")).toBe("kept");
    } finally {
      await single.close();
    }
  });
});
