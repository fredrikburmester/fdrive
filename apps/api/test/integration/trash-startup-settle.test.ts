import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MeResponse, ROUTES, TrashListResponse } from "@fdrive/contracts";
import { createDb, createShareRepo, createTrashItemRepo } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const DELETED_AT = "2026-11-01T08:00:00.000Z";

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

/**
 * Settling Trash at start against real PostgreSQL and a real folder: a
 * delete a crash interrupted, its row written and its item moved or not,
 * ends by what is on disk when the API starts, before it serves anyone.
 */
describe("Trash settled at start", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let database: ReturnType<typeof createDb>;
  let config: ReturnType<typeof loadConfig>;
  let composed: Awaited<ReturnType<typeof composeApp>> | undefined;

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({ users: [{ username: "alice", password: "alice-pass" }], files: {} }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage);
    database = createDb(postgres.connectionString);
    config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      FDRIVE_STORAGE_ROOT: storage.root,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
    });
  }, 180_000);

  afterAll(async () => {
    await composed?.close();
    await database?.close();
    await storage?.stop();
    await postgres?.stop();
  }, 180_000);

  const onDisk = (path: string) => storage.path("alice", path);
  async function put(path: string, content: string) {
    await mkdir(dirname(onDisk(path)), { recursive: true });
    await writeFile(onDisk(path), content);
  }

  async function call(
    path: string,
    init: { method?: string; cookie?: string; body?: unknown } = {},
  ) {
    return (composed as NonNullable<typeof composed>).app.request(path, {
      method: init.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  }

  it("lets an item that reached Trash arrive and leaves one that did not where it was", async () => {
    // A first start makes the files folder this installation's and alice's login.
    composed = await composeApp(config, silentLogger());
    const login = await call(ROUTES.auth.login, {
      method: "POST",
      body: { username: "alice", password: "alice-pass" },
    });
    const cookie = cookieFrom(login);
    const alice = MeResponse.parse(await login.json()).identity.id;
    await composed.close();
    composed = undefined;

    // Two deletes a crash interrupted: one after its rename, one before it.
    await put("/Photos/2024/a.jpg", "a");
    await put("/kept.txt", "kept");
    const shares = createShareRepo(database.db);
    const link = await shares.insert({
      identityId: alice,
      name: "Photos",
      description: "",
      scope: "read",
      paths: ["/Photos/2024"],
      expiresAt: null,
      maxDownloads: 0,
      presentation: "auto",
      passwordHash: null,
      at: new Date(),
    });
    const rows = createTrashItemRepo(database.db);
    const pending = (originalPath: string, name: string, kind: "file" | "dir") =>
      rows.begin({
        identityId: alice,
        originalPath,
        name,
        kind,
        size: kind === "file" ? 4 : 0,
        deletedAt: new Date(DELETED_AT),
        movingFrom: originalPath,
      });
    const photos = await pending("/Photos/2024", "2024", "dir");
    await mkdir(onDisk(`/.trash/${photos.id}`), { recursive: true });
    await rename(onDisk("/Photos/2024"), onDisk(`/.trash/${photos.id}/2024`));
    const stayed = await pending("/kept.txt", "kept.txt", "file");
    await mkdir(onDisk(`/.trash/${stayed.id}`), { recursive: true });

    composed = await composeApp(config, silentLogger());
    expect(await rows.pending()).toEqual([]);
    const listed = TrashListResponse.parse(
      await (await call(ROUTES.trash.list, { cookie })).json(),
    );
    expect(listed.entries.map((entry) => [entry.id, entry.originalPath, entry.deletedAt])).toEqual([
      [photos.id, "/Photos/2024", DELETED_AT],
    ]);
    // The link followed the folder into Trash; the delete that never moved left nothing behind.
    expect((await shares.get(link.id))?.paths).toEqual([`/.trash/${photos.id}/2024`]);
    expect(await readFile(onDisk("/kept.txt"), "utf8")).toBe("kept");
    expect(existsSync(onDisk(`/.trash/${stayed.id}`))).toBe(false);

    // The item that arrived restores to where it was deleted from, its link with it.
    const restored = await call(ROUTES.trash.restore, {
      method: "POST",
      cookie,
      body: { ids: [photos.id] },
    });
    expect(restored.status).toBe(200);
    expect(await readFile(onDisk("/Photos/2024/a.jpg"), "utf8")).toBe("a");
    expect((await shares.get(link.id))?.paths).toEqual(["/Photos/2024"]);

    // The next start finds nothing to settle.
    await composed.close();
    composed = await composeApp(config, silentLogger());
    const again = TrashListResponse.parse(await (await call(ROUTES.trash.list, { cookie })).json());
    expect(again.entries).toEqual([]);
  }, 180_000);
});
