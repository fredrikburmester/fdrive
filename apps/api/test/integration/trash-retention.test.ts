import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROUTES, TrashListResponse } from "@fdrive/contracts";
import {
  createAccessRepo,
  createActivityRepo,
  createDb,
  createRepos,
  createTrashItemRepo,
} from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActivityService } from "../../src/activity/service.js";
import { createIdentityStorageFactory } from "../../src/auth/storage-factory.js";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { createAccessFollowers } from "../../src/files/access.js";
import { createFileOperations } from "../../src/files/operations.js";
import { deploymentFilesFolder } from "../../src/local/files-folder.js";
import { createMetadataService } from "../../src/metadata/service.js";
import { createShareMoves } from "../../src/shares/moves.js";
import { createTrashItems } from "../../src/trash/items.js";
import { createTrashRetention } from "../../src/trash/retention.js";
import { createTrashSettingsService } from "../../src/trash/settings.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const DAY = 24 * 60 * 60_000;
const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

/**
 * Trash's retention against real PostgreSQL and a local folder, on a clock
 * the test moves: items trashed through fdrive at different times, then a
 * pass of the API's hourly retention once the oldest is past the
 * installation's 30 days.
 */
describe("Trash retention against real PostgreSQL and a local folder", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let database: ReturnType<typeof createDb>;
  let now = Date.now() - 40 * DAY;
  const clock = () => new Date(now);
  let composed: Awaited<ReturnType<typeof composeApp>> | undefined;
  let config: ReturnType<typeof loadConfig>;

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({
        users: [{ username: "alice", password: "alice-pass" }],
        files: { alice: { "/old.txt": "old", "/Old/inside.txt": "inside", "/new.txt": "new" } },
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage);
    config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      FDRIVE_STORAGE_ROOT: storage.root,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 13).toString("base64"),
    });
    database = createDb(postgres.connectionString);
  }, 180_000);

  afterAll(async () => {
    await composed?.close();
    await database?.close();
    await storage?.stop();
    await postgres?.stop();
  }, 180_000);

  async function call(path: string, options: { cookie?: string; body?: unknown } = {}) {
    if (composed === undefined) throw new Error("the API is not running");
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

  async function login(): Promise<string> {
    const response = await call(ROUTES.auth.login, {
      body: { username: "alice", password: "alice-pass" },
    });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  async function trash(path: string, kind: "file" | "dir") {
    const response = await call(ROUTES.fs.delete, {
      cookie: await login(),
      body: { items: [{ path, kind }] },
    });
    expect(response.status).toBe(200);
  }

  async function listed() {
    const response = await call(ROUTES.trash.list, { cookie: await login() });
    expect(response.status).toBe(200);
    return TrashListResponse.parse(await response.json()).entries;
  }

  async function trashed(): Promise<string[]> {
    return (await listed()).map((entry) => entry.originalPath).sort();
  }

  /** Each trashed item's original path, its Trash binding's state and its file's, from alice's history. */
  async function bindings(): Promise<Record<string, string>> {
    const rows = await database.db.execute<{ path: string; binding: string; file: string }>(
      sql`select b.original_virtual_path as path, b.state as binding, f.state as file
          from app.activity_trash_bindings b join app.activity_files f on f.id = b.file_id`,
    );
    return Object.fromEntries(rows.rows.map((row) => [row.path, `${row.binding} ${row.file}`]));
  }

  async function events(): Promise<{ action: string; path: string; reason: string | null }[]> {
    const rows = await database.db.execute<{
      action: string;
      path: string;
      reason: string | null;
    }>(sql`select action, after ->> 'path' as path, after ->> 'reason' as reason
           from app.activity_events where action = 'file.delete' and stage = 'outcome'
           order by owner_sequence`);
    return rows.rows;
  }

  it("deletes only what Trash kept longer than 30 days, and its history follows", async () => {
    composed = await composeApp(config, silentLogger(), clock);
    await trash("/old.txt", "file");
    await trash("/Old", "dir");
    now += 25 * DAY;
    await trash("/new.txt", "file");
    expect(await trashed()).toEqual(["/Old", "/new.txt", "/old.txt"]);
    expect(await bindings()).toEqual({
      "/Old": "bound trashed",
      "/new.txt": "bound trashed",
      "/old.txt": "bound trashed",
    });

    // Forty days after the first deletes, fifteen after the last, the hourly pass comes.
    now += 15 * DAY;
    const repos = createRepos(database.db);
    const storageFor = createIdentityStorageFactory({
      identities: repos.identities,
      folder: deploymentFilesFolder(config, repos),
    });
    const ownerPath = async (identityId: string, path: string) => ({ identityId, path });
    // Where each item lies on disk, from the rows the listing reads.
    const leaves = Object.fromEntries(
      (await listed()).map((entry) => [
        entry.originalPath,
        join(storage.root, "alice", ".trash", entry.id, entry.name),
      ]),
    );
    const access = createAccessFollowers({
      repo: createAccessRepo(database.db, clock),
      ownerPath,
      links: createShareMoves({ ownerPath }).resolve,
      usernameOf: async (identityId) => (await repos.identities.get(identityId))?.username ?? null,
    });
    const trashItems = createTrashItems({
      repo: createTrashItemRepo(database.db),
      access,
      homeOf: storageFor,
    });
    const retention = createTrashRetention({
      identities: repos.identities,
      storageFor,
      settings: createTrashSettingsService({ settings: repos.settings }),
      trash: trashItems,
      files: createFileOperations({
        activity: createActivityService({
          repo: createActivityRepo(database.db, clock),
          clock,
          pending: () => undefined,
        }),
        access,
        metadata: createMetadataService(repos),
        ownerPath,
        trash: trashItems,
        clock,
      }),
      clock,
      eventLog: { record: () => undefined },
    });
    expect(await retention.sweep()).toEqual({ purged: 2, deferred: 0 });

    expect(await trashed()).toEqual(["/new.txt"]);
    expect(existsSync(leaves["/old.txt"] as string)).toBe(false);
    expect(existsSync(leaves["/Old"] as string)).toBe(false);
    expect(existsSync(leaves["/new.txt"] as string)).toBe(true);
    expect(await bindings()).toEqual({
      "/Old": "purged deleted",
      "/new.txt": "bound trashed",
      "/old.txt": "purged deleted",
    });
    expect(await events()).toEqual(
      expect.arrayContaining([
        { action: "file.delete", path: "/old.txt", reason: "retention" },
        { action: "file.delete", path: "/Old", reason: "retention" },
      ]),
    );
    expect(await events()).toHaveLength(2);
  }, 180_000);
});
