import {
  EntryResponse,
  MeResponse,
  OkResponse,
  ROUTES,
  TrashListResponse,
} from "@fdrive/contracts";
import { createDb, createRepos } from "@fdrive/db";
import { startPostgres, startSftpgo } from "@fdrive/testkit";
import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { trashSettingsKey } from "../../src/trash/settings.js";

const TRASH_PATH = "/.trash";

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

/**
 * Exercises the fs and trash routes' conflict guard (`requireTargetFree`
 * in `fs/routes.ts`, and the same check inside `@fdrive/core`'s
 * `createRecycleFolderTrash.restore`) against a real SFTPGo container.
 * These are the cases where the container's own move/copy would otherwise
 * silently destroy whatever already sits at the target (see
 * `packages/sftpgo`'s fake, fixed to match the container's verified
 * behaviour): the routes must reject them with 409 before ever calling the
 * provider. Follows `trash-sftp.test.ts`'s composition pattern: one shared
 * Postgres and SFTPGo container, one composed app with
 * provider-bound Trash settings persisted, and plain `app.request` calls.
 */
describe("fs and trash conflict guards against a real SFTPGo container", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let sftp: Awaited<ReturnType<typeof startSftpgo>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let database: ReturnType<typeof createDb>;

  beforeAll(async () => {
    [postgres, sftp] = await Promise.all([
      startPostgres(),
      startSftpgo({
        users: [{ username: "alice", password: "alice-pass", permissions: { "/": ["*"] } }],
        folders: [],
        files: {},
        trash: { path: TRASH_PATH },
      }),
    ]);
    const config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      SFTPGO_URL: sftp.baseUrl,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
    });
    const noop = () => undefined;
    const logger = { info: noop, warn: noop, error: noop } as unknown as Logger;
    composed = await composeApp(config, logger);
    database = createDb(postgres.connectionString);
    const repos = createRepos(database.db);
    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: sftp.baseUrl });
    await repos.settings.set(trashSettingsKey(provider.id), {
      providerId: provider.id,
      revision: 1,
      enabled: true,
      path: TRASH_PATH,
      retentionHours: 72,
      rulesConfirmed: true,
    });
  }, 180000);

  afterAll(async () => {
    await composed?.close();
    await database?.close();
    await sftp?.stop();
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
      body: { username, password: `${username}-pass` },
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
});
