import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MeResponse, ROUTES, TrashListResponse } from "@fdrive/contracts";
import { createDb, createShareRepo, createTrashItemRepo } from "@fdrive/db";
import { trashItems } from "@fdrive/db/schema/app";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const OLD = "/.trash/.fdrive-move-v1";
const stamp = (iso: string) => (BigInt(new Date(iso).getTime()) * 1_000_000n).toString();
const T1 = "2026-10-01T08:00:00.000Z";
const T2 = "2026-10-02T09:30:00.000Z";
const T3 = "2026-10-03T10:00:00.000Z";
const T4 = "2026-10-04T11:15:00.000Z";
const LEAVES = {
  report: `${OLD}/file/p/docs/p/Å %20 50%.pdf/v/${stamp(T1)}`,
  photos: `${OLD}/dir/p/Photos/p/2024/v/${stamp(T2)}`,
  begun: `${OLD}/file/p/begun.txt/v/${stamp(T3)}`,
  renamed: `${OLD}/file/p/renamed.txt/v/${stamp(T4)}`,
};

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

/**
 * The start-up move of Trash's old layout against real PostgreSQL and a real
 * folder: what an earlier version left in `<home>/.trash/.fdrive-move-v1`,
 * a start interrupted halfway through moving it included, becomes Trash's
 * own folders when the API starts, each item with the path and time it was
 * deleted at and what followed it into the old place.
 */
describe("Trash's old layout moved at start", () => {
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

  it("moves each old item into a folder of its own, resuming an interrupted start", async () => {
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

    // What an earlier version left: nested folders, Unicode, a literal `%`,
    // a restore half done, and something loose that was never an item.
    await put(LEAVES.report, "report");
    await put(`${LEAVES.photos}/a.jpg`, "a");
    await put(`${LEAVES.photos}/deeper/c.jpg`, "c");
    await put(LEAVES.begun, "begun");
    await put(LEAVES.renamed, "renamed");
    await put(`${OLD}/file/p/stray.txt`, "stray");
    await mkdir(onDisk(`${OLD}/file/p/old/p/gone.txt/v`), { recursive: true });
    // A link to the folder followed it into the old layout.
    const shares = createShareRepo(database.db);
    const link = await shares.insert({
      identityId: alice,
      name: "Photos",
      description: "",
      scope: "read",
      paths: [LEAVES.photos],
      expiresAt: null,
      maxDownloads: 0,
      presentation: "auto",
      passwordHash: null,
      at: new Date(),
    });
    // A start that crashed: one item's row was written before its rename,
    // another's after it.
    const rows = createTrashItemRepo(database.db);
    await rows.begin({
      identityId: alice,
      originalPath: "/begun.txt",
      name: "begun.txt",
      kind: "file",
      size: 5,
      deletedAt: new Date(T3),
      movingFrom: LEAVES.begun,
    });
    const renamedId = randomUUID();
    await database.db.insert(trashItems).values({
      id: renamedId,
      identityId: alice,
      originalPath: "/renamed.txt",
      name: "renamed.txt",
      kind: "file",
      size: 7,
      deletedAt: new Date(T4),
      movingFrom: LEAVES.renamed,
    });
    await mkdir(onDisk(`/.trash/${renamedId}`));
    await rename(onDisk(LEAVES.renamed), onDisk(`/.trash/${renamedId}/renamed.txt`));

    composed = await composeApp(config, silentLogger());
    const listed = TrashListResponse.parse(
      await (await call(ROUTES.trash.list, { cookie })).json(),
    );
    expect(
      listed.entries
        .map((entry) => [entry.originalPath, entry.deletedAt, entry.name])
        .sort(([a = ""], [b = ""]) => (a < b ? -1 : 1)),
    ).toEqual([
      ["/Photos/2024", T2, "2024"],
      ["/begun.txt", T3, "begun.txt"],
      ["/docs/Å %20 50%.pdf", T1, "Å %20 50%.pdf"],
      ["/renamed.txt", T4, "renamed.txt"],
    ]);
    for (const entry of listed.entries)
      expect(existsSync(onDisk(`/.trash/${entry.id}/${entry.name}`))).toBe(true);
    expect(listed.entries.find((entry) => entry.name === "renamed.txt")?.id).toBe(renamedId);
    expect(await rows.pending()).toEqual([]);
    // Only what was never an item stays in the old layout.
    expect(await readdir(onDisk(`${OLD}/file/p`))).toEqual(["stray.txt"]);
    expect(existsSync(onDisk(`${OLD}/dir`))).toBe(false);
    const photos = listed.entries.find((entry) => entry.name === "2024");
    expect((await shares.get(link.id))?.paths).toEqual([`/.trash/${photos?.id}/2024`]);

    // A moved item restores to where it was deleted from.
    const restored = await call(ROUTES.trash.restore, {
      method: "POST",
      cookie,
      body: { ids: [photos?.id] },
    });
    expect(restored.status).toBe(200);
    expect(await readFile(onDisk("/Photos/2024/deeper/c.jpg"), "utf8")).toBe("c");
    expect((await shares.get(link.id))?.paths).toEqual(["/Photos/2024"]);

    // The next start finds nothing more to move.
    await composed.close();
    composed = await composeApp(config, silentLogger());
    const again = TrashListResponse.parse(await (await call(ROUTES.trash.list, { cookie })).json());
    expect(again.entries).toHaveLength(3);
  }, 180_000);
});
