import { mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EntryResponse,
  MeResponse,
  OkResponse,
  ROUTES,
  TrashListResponse,
} from "@fdrive/contracts";
import { createDb, createRepos } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { trashSettingsKey } from "../../src/trash/settings.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const TRASH_PATH = "/.trash";

/** Whether the temporary folder's disk ignores case, as a Mac's does by default. */
async function ignoresCase(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "fdrive-case-"));
  try {
    await writeFile(join(dir, "probe"), "");
    return await stat(join(dir, "PROBE")).then(
      () => true,
      () => false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const IGNORES_CASE = await ignoresCase();

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

/**
 * Exercises the fs and trash routes' conflict handling against a real local
 * folder: storage refuses a taken target for move, rename and copy, and
 * `@fdrive/core`'s `createRecycleFolderTrash.restore` moves with
 * `overwrite: false`. The routes must answer these with 409 and leave the
 * target as it was, and must not mistake a case-only rename on a disk that
 * ignores case for one. Follows `trash-local.test.ts`'s composition pattern: one Postgres,
 * one local folder, one composed app with provider-bound Trash settings
 * persisted, and plain `app.request` calls.
 */
describe("fs and trash conflict guards against a local folder", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let database: ReturnType<typeof createDb>;

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({ users: [{ username: "alice", password: "alice-pass" }], files: {} }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage);
    const config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      FDRIVE_STORAGE_ROOT: storage.root,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
    });
    composed = await composeApp(config, silentLogger());
    database = createDb(postgres.connectionString);
    const repos = createRepos(database.db);
    const provider = await repos.providers.ensure({ type: "local", baseUrl: "local" });
    await repos.settings.set(trashSettingsKey(provider.id), {
      providerId: provider.id,
      revision: 1,
      enabled: true,
      path: TRASH_PATH,
      retentionHours: 72,
    });
  }, 180000);

  afterAll(async () => {
    await composed?.close();
    await database?.close();
    await storage?.stop();
    await postgres?.stop();
  }, 180000);

  async function call(
    path: string,
    options: {
      method?: string;
      cookie?: string;
      body?: unknown;
      rawBody?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const jsonBody = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    return composed.app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(jsonBody !== undefined ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(jsonBody !== undefined ? { body: jsonBody } : {}),
      ...(options.rawBody !== undefined ? { body: options.rawBody } : {}),
    });
  }

  async function login(username: string) {
    const response = await call(ROUTES.auth.login, {
      method: "POST",
      body: { credential: { username, password: `${username}-pass` } },
    });
    expect(response.status).toBe(200);
    return { cookie: cookieFrom(response), me: MeResponse.parse(await response.json()) };
  }

  async function upload(cookie: string, path: string, content: string) {
    const response = await call(
      `${ROUTES.fs.upload}?path=${encodeURIComponent(path)}&mkdirParents=true`,
      { method: "PUT", cookie, rawBody: content },
    );
    expect(response.status).toBe(201);
    return EntryResponse.parse(await response.json());
  }

  async function download(cookie: string, path: string) {
    const response = await call(`${ROUTES.fs.download}?path=${encodeURIComponent(path)}`, {
      cookie,
    });
    expect(response.status).toBe(200);
    return response.text();
  }

  async function deleteItem(cookie: string, path: string, kind: "file" | "dir") {
    const response = await call(ROUTES.fs.delete, {
      method: "POST",
      cookie,
      body: { items: [{ path, kind }] },
    });
    expect(response.status).toBe(200);
    return OkResponse.parse(await response.json());
  }

  async function listTrash(cookie: string) {
    const response = await call(ROUTES.trash.list, { cookie });
    expect(response.status).toBe(200);
    return TrashListResponse.parse(await response.json());
  }

  it("rejects move, rename, and copy onto an existing target with 409, leaving the target untouched", async () => {
    const alice = await login("alice");
    const cookie = alice.cookie;

    // 1. move onto an existing file: 409, the target's bytes are unchanged.
    await upload(cookie, "/move-source.txt", "move source content");
    await upload(cookie, "/move-target.txt", "original move target content");

    const moveRes = await call(ROUTES.fs.move, {
      method: "POST",
      cookie,
      body: { path: "/move-source.txt", target: "/move-target.txt" },
    });
    expect(moveRes.status).toBe(409);
    expect(await download(cookie, "/move-target.txt")).toBe("original move target content");
    expect(await download(cookie, "/move-source.txt")).toBe("move source content");

    // 2. rename onto an existing sibling: 409.
    await upload(cookie, "/rename-source.txt", "rename source content");
    await upload(cookie, "/rename-sibling.txt", "original sibling content");

    const renameRes = await call(ROUTES.fs.rename, {
      method: "POST",
      cookie,
      body: { path: "/rename-source.txt", newName: "rename-sibling.txt" },
    });
    expect(renameRes.status).toBe(409);
    expect(await download(cookie, "/rename-sibling.txt")).toBe("original sibling content");
    expect(await download(cookie, "/rename-source.txt")).toBe("rename source content");

    // 3. copy onto an existing file: 409.
    await upload(cookie, "/copy-source.txt", "copy source content");
    await upload(cookie, "/copy-target.txt", "original copy target content");

    const copyRes = await call(ROUTES.fs.copy, {
      method: "POST",
      cookie,
      body: { path: "/copy-source.txt", target: "/copy-target.txt" },
    });
    expect(copyRes.status).toBe(409);
    expect(await download(cookie, "/copy-target.txt")).toBe("original copy target content");
  }, 180000);

  // Only a disk that ignores case (a Mac's) has "case.txt" and "CASE.txt" as one name.
  it.skipIf(!IGNORES_CASE)(
    "renames to another case on a disk that ignores case",
    async () => {
      const { cookie } = await login("alice");
      await upload(cookie, "/case/case.txt", "case");

      for (const [path, newName] of [
        ["/case/case.txt", "CASE.txt"],
        ["/case", "Case"],
      ] as const) {
        const response = await call(ROUTES.fs.rename, {
          method: "POST",
          cookie,
          body: { path, newName },
        });
        expect(response.status).toBe(200);
      }
      expect(await download(cookie, "/Case/CASE.txt")).toBe("case");
      expect(await readdir(join(storage.path("alice"), "Case"))).toEqual(["CASE.txt"]);
    },
    180000,
  );

  it("rejects a trash restore onto an existing file with 409 and failedId, leaving the trash leaf present", async () => {
    const alice = await login("alice");
    const cookie = alice.cookie;

    await upload(cookie, "/restore-target.txt", "will be trashed");
    await deleteItem(cookie, "/restore-target.txt", "file");
    const trashList = await listTrash(cookie);
    const entry = trashList.entries.find(
      (candidate) => candidate.originalPath === "/restore-target.txt",
    );
    if (entry === undefined) throw new Error("expected a trash entry for /restore-target.txt");

    await upload(cookie, "/restore-target.txt", "occupies the target now");

    const restoreRes = await call(ROUTES.trash.restore, {
      method: "POST",
      cookie,
      body: { ids: [entry.id] },
    });
    expect(restoreRes.status).toBe(409);
    const body = (await restoreRes.json()) as { error: { details?: Record<string, unknown> } };
    expect(body.error.details?.failedId).toBe(entry.id);

    expect(await download(cookie, "/restore-target.txt")).toBe("occupies the target now");
    const trashListAfter = await listTrash(cookie);
    expect(trashListAfter.entries.map((candidate) => candidate.id)).toContain(entry.id);
  }, 180000);

  it("retains a folder view while its provider directory is temporarily missing", async () => {
    const { cookie } = await login("alice");
    await upload(cookie, "/pinned-view/keep.txt", "kept");
    const saved = await call("/api/v1/folder-views", {
      method: "PUT",
      cookie,
      body: { path: "/pinned-view", mode: "tree" },
    });
    expect(saved.status).toBe(200);

    // Bypass application mutation hooks to model temporary provider visibility.
    await rename(storage.path("alice", "/pinned-view"), storage.path("alice", "/hidden-view"));
    const missing = await call("/api/v1/folder-views?path=/pinned-view", { cookie });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ view: null });

    await rename(storage.path("alice", "/hidden-view"), storage.path("alice", "/pinned-view"));
    const returned = await call("/api/v1/folder-views?path=/pinned-view", { cookie });
    expect(returned.status).toBe(200);
    expect(await returned.json()).toEqual({
      view: { path: "/pinned-view", mode: "tree", sort: null },
    });
  }, 180000);
});
