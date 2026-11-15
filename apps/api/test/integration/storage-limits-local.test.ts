import { existsSync } from "node:fs";
import {
  AdminUser,
  AdminUsersResponse,
  FEATURES_SETTINGS_KEY,
  ROUTES,
  StorageUsageResponse,
} from "@fdrive/contracts";
import { createDb, createRepos, INDEX_ROOT_ID, schema } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

/** What the index holds, by path under the root: bob's 705 bytes and alice's 16. */
const INDEXED: Readonly<Record<string, number>> = {
  "bob/big.mov": 600,
  "bob/docs/notes.txt": 5,
  // An item in bob's Trash: counted, never listed.
  "bob/.trash/0d9f8a52-6c1e-4f53-9a7b-2e4c6d8f0a1b/old.bin": 100,
  // Two identical copies: the same content hash.
  "alice/Projects/plan.txt": 8,
  "alice/Projects/plan-copy.txt": 8,
};

/**
 * Storage limits against Postgres and a real files folder: an administrator
 * sets a user's limit on System > Users, a write that would take the owner
 * of the folder it lands in over theirs is refused, and the Storage page
 * shows a login its own folder only. Usage comes from index rows written by
 * hand, as no indexer runs here.
 */
describe("storage usage and limits through the API", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({
        users: ["alice", "bob"].map((username) => ({ username, password: `${username}-password` })),
        files: {
          alice: { "/Projects/plan.txt": "the plan", "/Projects/plan-copy.txt": "the plan" },
          bob: { "/big.mov": "v".repeat(600), "/docs/notes.txt": "notes" },
        },
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage, ["alice"]);
    // The files folder counts as indexed with an indexer and a feature that needs it.
    const settings = createDb(postgres.connectionString);
    try {
      await createRepos(settings.db).settings.set(FEATURES_SETTINGS_KEY, {
        version: 1,
        revision: 1,
        values: {
          thumbnails: true,
          textSearch: false,
          searchOcr: false,
          semanticSearch: false,
          imageSearch: false,
          pdfOcr: false,
        },
        walkthroughComplete: true,
      });
    } finally {
      await settings.close();
    }
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 43).toString("base64"),
        FDRIVE_INDEXER_URL: "http://127.0.0.1:9",
      }),
      silentLogger(),
    );
    const database = createDb(postgres.connectionString);
    try {
      await database.db.insert(schema.files).values(
        Object.entries(INDEXED).map(([path, size]) => ({
          rootId: INDEX_ROOT_ID,
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          ext: path.includes(".", path.lastIndexOf("/")) ? path.slice(path.lastIndexOf(".")) : "",
          size,
          mtimeNs: 1_700_000_000_000_000_000n,
          sha256: path.startsWith("alice/Projects/") ? "c".repeat(64) : null,
        })),
      );
    } finally {
      await database.close();
    }
  }, 180_000);

  afterAll(async () => {
    await composed?.close();
    await storage?.stop();
    await postgres?.stop();
  }, 180_000);

  async function call(
    path: string,
    options: { method?: string; cookie?: string; body?: unknown; raw?: string } = {},
  ) {
    return composed.app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : options.raw !== undefined
          ? { body: options.raw }
          : {}),
    });
  }

  async function login(username: string): Promise<string> {
    const response = await call(ROUTES.auth.login, {
      method: "POST",
      body: { username, password: `${username}-password` },
    });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  const upload = (cookie: string, path: string, bytes: number) =>
    call(`${ROUTES.fs.upload}?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      cookie,
      raw: "x".repeat(bytes),
    });
  /** One piece of an upload sent in pieces. */
  const piece = (cookie: string, path: string, offset: number, bytes: number, final = false) =>
    call(
      `${ROUTES.fs.upload}?path=${encodeURIComponent(path)}&part=0123456789abcdef&offset=${offset}${final ? "&final=true" : ""}`,
      { method: "PUT", cookie, raw: "x".repeat(bytes) },
    );
  const limit = async (cookie: string, username: string, storageLimit: number | null) => {
    const response = await call(`${ROUTES.admin.users}/${username}`, {
      method: "PATCH",
      cookie,
      body: { storageLimit },
    });
    expect(response.status).toBe(200);
    return AdminUser.parse(await response.json());
  };
  async function refused(response: Promise<Response>): Promise<void> {
    const settled = await response;
    expect(settled.status).toBe(507);
    expect(await settled.json()).toMatchObject({
      error: { kind: "storage_limit_reached", message: "Storage limit reached" },
    });
  }

  it("refuses writes over the limit of the folder's owner, and shows each login its own folder", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    const shared = await call(ROUTES.grants.list, {
      method: "POST",
      cookie: alice,
      body: { path: "/Projects", username: "bob", access: "write" },
    });
    expect(shared.status).toBeLessThan(300);

    // System > Users shows what each folder holds; only administrators set limits.
    const users = AdminUsersResponse.parse(
      await (await call(ROUTES.admin.users, { cookie: alice })).json(),
    ).users.map(({ username, storageUsed, storageLimit }) => ({
      username,
      storageUsed,
      storageLimit,
    }));
    expect(users).toEqual([
      { username: "alice", storageUsed: 16, storageLimit: null },
      { username: "bob", storageUsed: 705, storageLimit: null },
    ]);
    expect(
      (
        await call(`${ROUTES.admin.users}/bob`, {
          method: "PATCH",
          cookie: bob,
          body: { storageLimit: 1 },
        })
      ).status,
    ).toBe(403);
    expect(await limit(alice, "bob", 1_000)).toMatchObject({
      storageUsed: 705,
      storageLimit: 1_000,
    });

    // 705 bytes used of 1,000: 200 more fit, 400 do not, and nothing is left behind.
    expect((await upload(bob, "/fits.bin", 200)).status).toBe(201);
    await refused(upload(bob, "/too-big.bin", 400));
    expect(existsSync(storage.path("bob", "/too-big.bin"))).toBe(false);
    // An upload sent in pieces shares the room: the 200 bytes already sent count.
    expect((await piece(bob, "/pieces.bin", 0, 200)).status).toBe(204);
    await refused(piece(bob, "/pieces.bin", 200, 200, true));
    expect((await piece(bob, "/pieces.bin", 200, 90, true)).status).toBe(201);
    expect(existsSync(storage.path("bob", "/pieces.bin"))).toBe(true);
    await refused(
      call(ROUTES.fs.copy, {
        method: "POST",
        cookie: bob,
        body: { path: "/big.mov", target: "/again.mov" },
      }),
    );
    await refused(
      call(ROUTES.fs.duplicate, { method: "POST", cookie: bob, body: { path: "/big.mov" } }),
    );

    // A write in a shared folder counts against its owner, not the writer.
    expect((await upload(bob, "/Shared with me/Projects/fits.bin", 400)).status).toBe(201);
    await limit(alice, "alice", 10);
    await refused(upload(bob, "/Shared with me/Projects/too-big.bin", 400));
    // So does a move into it: bob's 600 bytes would land in alice's files.
    await refused(
      call(ROUTES.fs.move, {
        method: "POST",
        cookie: bob,
        body: { path: "/big.mov", target: "/Shared with me/Projects/big.mov" },
      }),
    );
    expect(existsSync(storage.path("bob", "/big.mov"))).toBe(true);

    // Bob's Storage page: his own folder only, by kind, with what is in fdrive's Trash
    // counted but not listed.
    const page = await call(ROUTES.storage, { cookie: bob });
    expect(page.status).toBe(200);
    expect(StorageUsageResponse.parse(await page.json())).toEqual({
      indexed: true,
      used: 705,
      limit: 1_000,
      kinds: [
        { kind: "images", bytes: 0 },
        { kind: "videos", bytes: 600 },
        { kind: "documents", bytes: 5 },
        { kind: "audio", bytes: 0 },
        { kind: "other", bytes: 100 },
      ],
      largest: [
        { path: "/big.mov", size: 600, modifiedAt: "2023-11-14T22:13:20.000Z" },
        { path: "/docs/notes.txt", size: 5, modifiedAt: "2023-11-14T22:13:20.000Z" },
      ],
      // Alice's identical files are in a folder shared with bob, but not in his own.
      duplicates: [],
    });
    const alicePage = StorageUsageResponse.parse(
      await (await call(ROUTES.storage, { cookie: alice })).json(),
    );
    expect(alicePage.duplicates).toEqual([
      { size: 8, paths: ["/Projects/plan-copy.txt", "/Projects/plan.txt"] },
    ]);

    // No limit, no refusal.
    await limit(alice, "bob", null);
    expect((await upload(bob, "/now-fits.bin", 400)).status).toBe(201);
  });
});
