import {
  EntryResponse,
  ListResponse,
  MeResponse,
  OkResponse,
  ROUTES,
  TrashListResponse,
  TrashRestoreResponse,
  TrashStatusResponse,
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
 * Exercises the trash routes (`/api/v1/trash/*`) plus the `fs/delete` and
 * `fs/list` interactions with a trash, against a real SFTPGo container
 * seeded with the Event Manager recycle-folder rule described in
 * `docs/DEVELOPMENT.md`. Follows `accounts-sftp.test.ts`'s composition
 * pattern: one shared Postgres and SFTPGo container, one composed app with
 * provider-bound Trash settings persisted, and plain `app.request` calls per user.
 */
describe("trash against real PostgreSQL and SFTPGo", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let sftp: Awaited<ReturnType<typeof startSftpgo>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let database: ReturnType<typeof createDb>;

  beforeAll(async () => {
    [postgres, sftp] = await Promise.all([
      startPostgres(),
      startSftpgo({
        users: ["alice", "carol"].map((username) => ({
          username,
          password: `${username}-pass`,
          permissions: { "/": ["*"] },
        })),
        folders: [],
        files: {},
        trash: { path: TRASH_PATH },
      }),
    ]);
    const config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      SFTPGO_URL: sftp.baseUrl,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
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

  async function listFs(cookie: string, path = "/") {
    const response = await call(`${ROUTES.fs.list}?path=${encodeURIComponent(path)}`, { cookie });
    expect(response.status).toBe(200);
    return ListResponse.parse(await response.json());
  }

  it("moves deletes into the trash, lists and hides it from fs/list, restores, resolves conflicts, purges, empties, and isolates users", async () => {
    const alice = await login("alice");
    const aliceCookie = alice.cookie;

    // 1. trash status is available with the configured path and retention.
    const status = TrashStatusResponse.parse(
      await (await call(ROUTES.trash.status, { cookie: aliceCookie })).json(),
    );
    expect(status).toEqual({ available: true, path: TRASH_PATH, retentionHours: 72 });

    // 2. delete a file and a directory whose names contain spaces, Unicode,
    // and a literal "%20" (not a URL-encoded space).
    const spacedName = "My Report (final).txt";
    const unicodeName = "héllo wörld 名前.txt";
    const percentName = "literal%20name.txt";
    await upload(aliceCookie, `/${spacedName}`, "spaced content");
    await upload(aliceCookie, `/${unicodeName}`, "unicode content");
    await upload(aliceCookie, `/A Folder/${percentName}`, "percent content");

    await deleteItem(aliceCookie, `/${spacedName}`, "file");
    await deleteItem(aliceCookie, `/${unicodeName}`, "file");
    await deleteItem(aliceCookie, "/A Folder", "dir");

    // 3. the trash list parses originalPath, name, and deletedAt correctly
    // for every deleted item, including the folder's file.
    const afterDeletes = await listTrash(aliceCookie);
    expect(afterDeletes.truncated).toBe(false);
    const byName = new Map(afterDeletes.entries.map((entry) => [entry.name, entry]));
    expect(byName.get(spacedName)).toMatchObject({
      originalPath: `/${spacedName}`,
      name: spacedName,
    });
    expect(byName.get(unicodeName)).toMatchObject({
      originalPath: `/${unicodeName}`,
      name: unicodeName,
    });
    expect(byName.get(percentName)).toMatchObject({
      originalPath: `/A Folder/${percentName}`,
      name: percentName,
    });
    for (const entry of afterDeletes.entries) {
      expect(new Date(entry.deletedAt).toString()).not.toBe("Invalid Date");
    }

    // 4. fs/list never shows the trash folder itself.
    const rootListing = await listFs(aliceCookie, "/");
    expect(rootListing.entries.some((entry) => entry.name === ".trash")).toBe(false);

    // 5. restore the spaced-name file to its original path.
    const spacedEntry = byName.get(spacedName);
    if (spacedEntry === undefined) throw new Error("expected the spaced-name trash entry");
    const restoreSame = await call(ROUTES.trash.restore, {
      method: "POST",
      cookie: aliceCookie,
      body: { ids: [spacedEntry.id] },
    });
    expect(restoreSame.status).toBe(200);
    const restoreSameBody = TrashRestoreResponse.parse(await restoreSame.json());
    expect(restoreSameBody.restored[0]?.path).toBe(`/${spacedName}`);

    // 6. deleting it again and uploading a fresh file at the same path, then
    // restoring the older trash entry to its default (original) target,
    // conflicts.
    await deleteItem(aliceCookie, `/${spacedName}`, "file");
    const secondTrashList = await listTrash(aliceCookie);
    const secondSpacedEntry = secondTrashList.entries.find((entry) => entry.name === spacedName);
    if (secondSpacedEntry === undefined) throw new Error("expected a second spaced-name entry");
    await upload(aliceCookie, `/${spacedName}`, "a fresh file occupying the same path");

    const restoreConflict = await call(ROUTES.trash.restore, {
      method: "POST",
      cookie: aliceCookie,
      body: { ids: [secondSpacedEntry.id] },
    });
    expect(restoreConflict.status).toBe(409);
    const conflictBody = (await restoreConflict.json()) as {
      error: { details?: Record<string, unknown> };
    };
    expect(conflictBody.error.details?.failedId).toBe(secondSpacedEntry.id);

    // 7. restoring the same entry to a brand-new target under a new parent
    // folder succeeds (mkdir parents happens automatically).
    const restoreNewTarget = await call(ROUTES.trash.restore, {
      method: "POST",
      cookie: aliceCookie,
      body: { ids: [secondSpacedEntry.id], target: "/recovered/from-trash/moved.txt" },
    });
    expect(restoreNewTarget.status).toBe(200);
    const newTargetBody = TrashRestoreResponse.parse(await restoreNewTarget.json());
    expect(newTargetBody.restored[0]?.path).toBe("/recovered/from-trash/moved.txt");

    // 8. purge the Unicode-named entry permanently.
    const beforePurge = await listTrash(aliceCookie);
    const unicodeEntry = beforePurge.entries.find((entry) => entry.name === unicodeName);
    if (unicodeEntry === undefined) throw new Error("expected the unicode trash entry");
    const purgeRes = await call(ROUTES.trash.purge, {
      method: "POST",
      cookie: aliceCookie,
      body: { ids: [unicodeEntry.id] },
    });
    expect(purgeRes.status).toBe(200);
    const afterPurge = await listTrash(aliceCookie);
    expect(afterPurge.entries.some((entry) => entry.id === unicodeEntry.id)).toBe(false);

    // 9. a second user (carol) never sees alice's trash entries.
    const carol = await login("carol");
    await upload(carol.cookie, "/carol-own.txt", "carol's file");
    await deleteItem(carol.cookie, "/carol-own.txt", "file");
    const carolTrash = await listTrash(carol.cookie);
    expect(carolTrash.entries.map((entry) => entry.name)).toEqual(["carol-own.txt"]);
    const aliceTrashAfterCarol = await listTrash(aliceCookie);
    expect(aliceTrashAfterCarol.entries.every((entry) => entry.name !== "carol-own.txt")).toBe(
      true,
    );

    // 10. empty alice's trash entirely; her remaining entries (the
    // percent-named file) are gone, but carol's trash is untouched.
    const emptyRes = await call(ROUTES.trash.empty, { method: "POST", cookie: aliceCookie });
    expect(emptyRes.status).toBe(200);
    const aliceTrashAfterEmpty = await listTrash(aliceCookie);
    expect(aliceTrashAfterEmpty.entries).toEqual([]);
    const carolTrashAfterAliceEmpty = await listTrash(carol.cookie);
    expect(carolTrashAfterAliceEmpty.entries.map((entry) => entry.name)).toEqual(["carol-own.txt"]);
  }, 180000);
});
