import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OkResponse, ROUTES, TrashListResponse, TrashRestoreResponse } from "@fdrive/contracts";
import { StorageError, type StorageProvider, trashItemPath } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createLocalStorage } from "@fdrive/local";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityFixture } from "../../test/activity-fixture.js";
import { testFileOperations } from "../../test/file-operations.js";
import { type MemoryTrashItemRepo, memoryTrashItemRepo } from "../../test/trash-items.js";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import type { AccessFollowers } from "../files/access.js";
import type { FileActor, FileOperations } from "../files/operations.js";
import { createMetadataService, type MetadataService } from "../metadata/service.js";
import { registerTrashRoutes, type TrashRoutesDeps } from "./routes.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_STORAGE_ROOT: "/srv/files",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

/** Setup is complete, so the setup gate lets every route through. */
const READY = async () => false;

const ALICE_IDENTITY_ID = "00000000-0000-4000-8000-0000000000a1";
const BOB_IDENTITY_ID = "00000000-0000-4000-8000-0000000000b1";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const CLOCK_ISO = "2024-06-01T00:00:00.000Z";
const TRASH_PATH = "/.trash";
/** A well-formed Trash item id. */
const ITEM_ID = "7a4b2c1d-3e5f-4a6b-8c7d-9e0f1a2b3c4d";

function createTestLogger(): Logger {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return logger as unknown as Logger;
}

const FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  alice: {
    "/hello.txt": "hello world",
    "/dir/nested.txt": "nested contents",
  },
  bob: {
    "/bob.txt": "bob's file",
  },
};

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

/** A user's files in a fresh home folder on disk, the way the local folder serves them. */
async function homeWith(files: Readonly<Record<string, string>>): Promise<StorageProvider> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fdrive-trash-routes-")));
  folders.push(root);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const target = join(home, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return createLocalStorage({ home });
}

/**
 * Access followers that record what they are told, as links and shares with
 * people follow paths; Trash's rows change in `trash` as a transaction would.
 */
function recordingFollower() {
  const follow = {
    onMoved: vi.fn(async (_identityId: string, _from: string, _to: string, _isDir: boolean) => {}),
    onDeleted: vi.fn(async (_identityId: string, _path: string, _isDir: boolean) => {}),
  };
  const access = (trash: MemoryTrashItemRepo): AccessFollowers => ({
    async run(_identityId, _paths, work) {
      const transaction = trash.transaction();
      const value = await work({
        moved: follow.onMoved,
        removed: follow.onDeleted,
        trash: transaction.changes,
      });
      transaction.commit();
      return value;
    },
    moved: follow.onMoved,
    removed: follow.onDeleted,
  });
  return { ...follow, access };
}

/** A row for an item in Trash that its storage may not hold, for routes that fail before storage does. */
async function trashRow(repo: MemoryTrashItemRepo, name = "hello.txt"): Promise<string> {
  const item = await repo.begin({
    identityId: ALICE_IDENTITY_ID,
    originalPath: `/${name}`,
    name,
    kind: "file",
    size: 11,
    deletedAt: new Date(CLOCK_ISO),
    movingFrom: `/${name}`,
  });
  const transaction = repo.transaction();
  await transaction.changes.entered(item.id, trashItemPath(item.id, name));
  transaction.commit();
  return item.id;
}

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly storage: StorageProvider;
  readonly metadata: MetadataService;
  readonly activity: ReturnType<typeof activityFixture>;
  readonly trash: MemoryTrashItemRepo;
  /** Moves `path` to Trash as the file operations do, with nothing following and no history. */
  put(path: string): Promise<string>;
  /** `put`, and what is kept by path follows, as the file operations' metadata step does. */
  putWithMetadata(path: string): Promise<string>;
}

async function buildHarness(
  opts: {
    username?: string;
    identityId?: string;
    /** What follows items into Trash and out, as folders shared with people do. */
    follower?: ReturnType<typeof recordingFollower>;
    /** Trash's rows, shared with another harness. */
    trash?: MemoryTrashItemRepo;
  } = {},
): Promise<Harness> {
  const username = opts.username ?? "alice";
  const clock = () => new Date(CLOCK_ISO);
  const activity = activityFixture(clock);
  const storage = await homeWith(FILES[username] ?? {});
  const trash = opts.trash ?? memoryTrashItemRepo();

  const identityId =
    opts.identityId ?? (username === "alice" ? ALICE_IDENTITY_ID : BOB_IDENTITY_ID);
  const principal: Principal = {
    accountId: ACCOUNT_ID,
    identityId,
    username,
    storage,
    isAdmin: false,
  };

  const config = loadConfig(REQUIRED_ENV);
  const metadata = createMetadataService(createMemoryRepos());

  const homeOf = async () => storage;
  const deps: TrashRoutesDeps = {
    activity: activity.service,
    files: testFileOperations({
      activity: activity.service,
      metadata,
      clock,
      trashRepo: trash,
      homeOf,
      ...(opts.follower === undefined ? {} : { access: opts.follower.access(trash) }),
    }),
    trash,
  };
  // Deletes before the test begins: through the same rows, with nothing following.
  const setup: FileOperations = testFileOperations({ clock, trashRepo: trash, homeOf });
  const actor: FileActor = { identityId, storage, recorded: null };
  const put = async (path: string) => {
    const { item } = await setup.trash(actor, path);
    const id = item.leaf.split("/")[2];
    if (id === undefined) throw new Error(`expected ${path} in Trash`);
    return id;
  };

  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(CLOCK_ISO),
    clock,
    principalResolver: async () => principal,
    setupRequired: READY,
    registerRoutes: (groups) => registerTrashRoutes(groups, deps),
  });

  return {
    app,
    storage,
    metadata,
    activity,
    trash,
    put,
    async putWithMetadata(path) {
      const id = await put(path);
      const leaf = trashItemPath(id, path.split("/").at(-1) as string);
      const { kind } = await storage.stat(leaf);
      await metadata.onMoved(identityId, path, leaf, kind === "dir");
      return id;
    },
  };
}

/** The listing as the route returns it. */
async function listed(app: Harness["app"]) {
  return TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
}

function requestedWith(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...init.headers, "x-requested-with": "fdrive" } };
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface ErrorJson {
  error: { kind: string; message: string; details?: Record<string, unknown> };
}

describe("GET /trash", () => {
  it("lists thousands of items from one query of the rows, reading no storage", async () => {
    const { app, storage, trash } = await buildHarness();
    for (let at = 0; at < 3000; at++) await trashRow(trash, `file-${at}.txt`);
    const list = vi.spyOn(trash, "list");
    const storageList = vi.spyOn(storage, "list");
    const storageStat = vi.spyOn(storage, "stat");

    const body = await listed(app);

    expect(body.entries).toHaveLength(3000);
    expect(body.truncated).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(ALICE_IDENTITY_ID, 10_000);
    expect(storageList).not.toHaveBeenCalled();
    expect(storageStat).not.toHaveBeenCalled();
  });

  it("says when Trash holds more than the page lists", async () => {
    const { app, trash } = await buildHarness();
    vi.spyOn(trash, "list").mockResolvedValue({ items: [], truncated: true });
    expect((await listed(app)).truncated).toBe(true);
  });

  it("lists a deleted file and a deleted directory, with parsed originalPath, name, and deletedAt", async () => {
    const { app, put } = await buildHarness();
    await put("/hello.txt");
    await put("/dir");

    const res = await app.request(ROUTES.trash.list);
    expect(res.status).toBe(200);
    const body = TrashListResponse.parse(await readJson(res));
    expect(body.truncated).toBe(false);
    const byName = new Map(body.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("hello.txt")).toMatchObject({
      originalPath: "/hello.txt",
      name: "hello.txt",
      size: 11,
    });
    // A deleted folder is one entry, its files still inside it.
    expect(byName.get("dir")).toMatchObject({ originalPath: "/dir", name: "dir" });
    expect(body.entries).toHaveLength(2);
    expect(byName.get("hello.txt")?.deletedAt).toBe(CLOCK_ISO);
  });

  it("keeps a second user's trash isolated from the first", async () => {
    const alice = await buildHarness();
    await alice.put("/hello.txt");
    // One table of rows, as in the database.
    const bob = await buildHarness({ username: "bob", trash: alice.trash });
    await bob.put("/bob.txt");

    const aliceList = TrashListResponse.parse(
      await readJson(await alice.app.request(ROUTES.trash.list)),
    );
    const bobList = TrashListResponse.parse(
      await readJson(await bob.app.request(ROUTES.trash.list)),
    );
    expect(aliceList.entries.map((e) => e.name)).toEqual(["hello.txt"]);
    expect(bobList.entries.map((e) => e.name)).toEqual(["bob.txt"]);
  });
});

describe("POST /trash/restore", () => {
  it("brings what followed an item into Trash back with it, to its place or another", async () => {
    const follower = recordingFollower();
    const { app, put } = await buildHarness({ follower });
    await put("/dir");
    await put("/hello.txt");
    const entries = TrashListResponse.parse(
      await readJson(await app.request(ROUTES.trash.list)),
    ).entries;
    const leaf = (name: string) => {
      const entry = entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`expected ${name} in Trash`);
      return entry.id;
    };
    const restore = (body: unknown) =>
      app.request(
        ROUTES.trash.restore,
        requestedWith({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    expect((await restore({ ids: [leaf("dir")] })).status).toBe(200);
    expect((await restore({ ids: [leaf("hello.txt")], target: "/again.txt" })).status).toBe(200);

    expect(follower.onMoved.mock.calls).toEqual([
      [ALICE_IDENTITY_ID, trashItemPath(leaf("dir"), "dir"), "/dir", true],
      [ALICE_IDENTITY_ID, trashItemPath(leaf("hello.txt"), "hello.txt"), "/again.txt", false],
    ]);
    expect(follower.onDeleted).not.toHaveBeenCalled();
  });

  it("brings metadata back from Trash on a restore to the original path", async () => {
    const { app, storage, metadata, putWithMetadata } = await buildHarness();
    await metadata.addFavorite(ALICE_IDENTITY_ID, "/hello.txt", "file");
    await putWithMetadata("/hello.txt");
    expect(await metadata.listFavorites(ALICE_IDENTITY_ID)).toEqual([]);
    const listed = TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
    const id = listed.entries[0]?.id;
    if (id === undefined) throw new Error("expected a trash entry");
    const onMovedSpy = vi.spyOn(metadata, "onMoved");

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      }),
    );

    expect(res.status).toBe(200);
    const body = TrashRestoreResponse.parse(await readJson(res));
    expect(body.restored).toHaveLength(1);
    expect(body.restored[0]?.path).toBe("/hello.txt");
    // Only what followed the item into Trash moves, back out with it.
    expect(onMovedSpy.mock.calls).toEqual([
      [ALICE_IDENTITY_ID, trashItemPath(id, "hello.txt"), "/hello.txt", false],
    ]);
    expect((await metadata.listFavorites(ALICE_IDENTITY_ID)).map((entry) => entry.path)).toEqual([
      "/hello.txt",
    ]);
    expect(await storage.statFile("/hello.txt")).toMatchObject({ size: 11 });
  });

  it("brings metadata from Trash to an explicit restore target", async () => {
    const { app, metadata, putWithMetadata } = await buildHarness();
    await metadata.addFavorite(ALICE_IDENTITY_ID, "/hello.txt", "file");
    await putWithMetadata("/hello.txt");
    const listed = TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
    const id = listed.entries[0]?.id;
    if (id === undefined) throw new Error("expected a trash entry");

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id], target: "/restored/moved.txt" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = TrashRestoreResponse.parse(await readJson(res));
    expect(body.restored[0]?.path).toBe("/restored/moved.txt");
    expect((await metadata.listFavorites(ALICE_IDENTITY_ID)).map((entry) => entry.path)).toEqual([
      "/restored/moved.txt",
    ]);
  });

  it("gives a new file at the original path nothing of the trashed item's metadata", async () => {
    const { app, storage, metadata, putWithMetadata } = await buildHarness();
    await metadata.addFavorite(ALICE_IDENTITY_ID, "/hello.txt", "file");
    await putWithMetadata("/hello.txt");
    const listed = TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
    const id = listed.entries[0]?.id;
    if (id === undefined) throw new Error("expected a trash entry");
    await storage.upload("/hello.txt", new TextEncoder().encode("replacement contents"));
    const onMoved = vi.spyOn(metadata, "onMoved");

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id], target: "/recovered.txt" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(onMoved.mock.calls).toEqual([
      [ALICE_IDENTITY_ID, trashItemPath(id, "hello.txt"), "/recovered.txt", false],
    ]);
    expect((await metadata.listFavorites(ALICE_IDENTITY_ID)).map((entry) => entry.path)).toEqual([
      "/recovered.txt",
    ]);
    expect(await storage.statFile("/recovered.txt")).toMatchObject({ size: 11 });
  });

  it("brings a restored folder's metadata subtree back from Trash", async () => {
    const { app, metadata, putWithMetadata } = await buildHarness();
    await metadata.addFavorite(ALICE_IDENTITY_ID, "/dir/nested.txt", "file");
    await metadata.setFolderView(ALICE_IDENTITY_ID, "/dir", { mode: "grid" });
    await putWithMetadata("/dir");
    const listed = TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
    const id = listed.entries[0]?.id;
    if (id === undefined) throw new Error("expected a trash entry");
    const onMovedSpy = vi.spyOn(metadata, "onMoved");

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id], target: "/restored-dir" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(onMovedSpy).toHaveBeenCalledWith(
      ALICE_IDENTITY_ID,
      trashItemPath(id, "dir"),
      "/restored-dir",
      true,
    );
    expect((await metadata.listFavorites(ALICE_IDENTITY_ID)).map((entry) => entry.path)).toEqual([
      "/restored-dir/nested.txt",
    ]);
    await expect(metadata.getFolderView(ALICE_IDENTITY_ID, "/dir")).resolves.toBeNull();
    await expect(metadata.getFolderView(ALICE_IDENTITY_ID, "/restored-dir")).resolves.toMatchObject(
      { mode: "grid" },
    );
  });

  it("returns 409 with details.failedId when the restore target already exists, via the real core-provided trash over a folder on disk (not a mocked provider)", async () => {
    const { app, storage, put } = await buildHarness();
    await put("/hello.txt");
    await storage.upload("/hello.txt", new TextEncoder().encode("new content"));
    const listed = TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
    const id = listed.entries[0]?.id;
    if (id === undefined) throw new Error("expected a trash entry");

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      }),
    );

    expect(res.status).toBe(409);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.details?.failedId).toBe(id);
    // The conflict came from `@fdrive/core`'s `createTrash().restore`, not any
    // pre-restore check of the route's own (the route has none): confirm the target file that
    // was already there is untouched and the trashed leaf is still present.
    const kept = await storage.open("/hello.txt");
    expect(await new Response(kept.stream()).text()).toBe("new content");
    const stillTrashed = TrashListResponse.parse(
      await readJson(await app.request(ROUTES.trash.list)),
    );
    expect(stillTrashed.entries.map((entry) => entry.id)).toContain(id);
  });

  it("returns bad_request for an id that cannot name a Trash item", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["not-a-leaf"] }),
      }),
    );

    expect(res.status).toBe(400);
  });

  it("returns bad_request for a path of Trash's old layout, which is no id", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [".fdrive-move-v1/file/p/hello.txt/v/168176641123456789"] }),
      }),
    );

    expect(res.status).toBe(400);
  });

  it("propagates a non-StorageError from trash.restore as an internal error", async () => {
    const boom = new Error("boom");
    const memory = createMemoryStorage();
    // The route has no pre-restore check of its own: it looks the item up
    // and goes straight to `trash.restore`.
    const storage: StorageProvider = {
      ...memory,
      trash: { ...memory.trash, restore: () => Promise.reject(boom) },
    };
    const trash = memoryTrashItemRepo();
    const id = await trashRow(trash);
    const principal: Principal = {
      accountId: ACCOUNT_ID,
      identityId: ALICE_IDENTITY_ID,
      username: "alice",
      storage,
      isAdmin: false,
    };
    const clock = () => new Date(CLOCK_ISO);
    const deps: TrashRoutesDeps = {
      activity: activityFixture(clock).service,
      files: testFileOperations({ trashRepo: trash }),
      trash,
    };
    const app = createApp({
      config: loadConfig(REQUIRED_ENV),
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date(CLOCK_ISO),
      clock,
      principalResolver: async () => principal,
      setupRequired: READY,
      registerRoutes: (groups) => registerTrashRoutes(groups, deps),
    });

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      }),
    );

    expect(res.status).toBe(500);
  });

  it("attaches failedId even when the underlying StorageError carries no details", async () => {
    const memory = createMemoryStorage();
    // The route has no pre-restore check of its own: it looks the item up
    // and goes straight to `trash.restore`.
    const storage: StorageProvider = {
      ...memory,
      trash: {
        ...memory.trash,
        restore: () => Promise.reject(new StorageError("conflict", "already exists")),
      },
    };
    const trash = memoryTrashItemRepo();
    const id = await trashRow(trash);
    const principal: Principal = {
      accountId: ACCOUNT_ID,
      identityId: ALICE_IDENTITY_ID,
      username: "alice",
      storage,
      isAdmin: false,
    };
    const clock = () => new Date(CLOCK_ISO);
    const deps: TrashRoutesDeps = {
      activity: activityFixture(clock).service,
      files: testFileOperations({ trashRepo: trash }),
      trash,
    };
    const app = createApp({
      config: loadConfig(REQUIRED_ENV),
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date(CLOCK_ISO),
      clock,
      principalResolver: async () => principal,
      setupRequired: READY,
      registerRoutes: (groups) => registerTrashRoutes(groups, deps),
    });

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      }),
    );

    expect(res.status).toBe(409);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.details).toEqual({ failedId: id });
  });

  it("returns not_found for an id Trash does not hold, before touching storage", async () => {
    const { app, storage } = await buildHarness();
    const restore = vi.spyOn(storage.trash, "restore");

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [ITEM_ID] }),
      }),
    );

    expect(res.status).toBe(404);
    expect((await readJson<ErrorJson>(res)).error.details).toMatchObject({ failedId: ITEM_ID });
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("POST /trash/purge", () => {
  it("permanently removes the given ids", async () => {
    const { app, put } = await buildHarness();
    await put("/hello.txt");
    const listed = TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
    const id = listed.entries[0]?.id;
    if (id === undefined) throw new Error("expected a trash entry");

    const res = await app.request(
      ROUTES.trash.purge,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(OkResponse.parse({ ok: true }));
    const after = TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
    expect(after.entries).toEqual([]);
  });

  it("leaves no empty folders in the Trash folder after a restore and a purge", async () => {
    const { app, storage, put } = await buildHarness();
    await put("/dir/nested.txt");
    await put("/hello.txt");
    const [first, second] = TrashListResponse.parse(
      await readJson(await app.request(ROUTES.trash.list)),
    ).entries.map((entry) => entry.id);
    const post = (route: string, ids: (string | undefined)[]) =>
      app.request(
        route,
        requestedWith({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids }),
        }),
      );

    expect((await post(ROUTES.trash.restore, [first])).status).toBe(200);
    expect((await post(ROUTES.trash.purge, [second])).status).toBe(200);

    expect(await storage.list(TRASH_PATH)).toEqual([]);
  });

  it("returns bad_request for an invalid id", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      ROUTES.trash.purge,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["../escape"] }),
      }),
    );

    expect(res.status).toBe(400);
  });

  it("ends what followed a purged item into Trash, even with a new item where it was", async () => {
    const follower = recordingFollower();
    const { app, storage, metadata, put } = await buildHarness({ follower });
    await metadata.addFavorite(ALICE_IDENTITY_ID, "/dir", "dir");
    await put("/dir");
    await put("/hello.txt");
    await storage.upload("/hello.txt", new TextEncoder().encode("a new file"));
    const { entries } = await listed(app);

    const res = await app.request(
      ROUTES.trash.purge,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: entries.map((entry) => entry.id) }),
      }),
    );

    expect(res.status).toBe(200);
    expect(follower.onDeleted.mock.calls.sort()).toEqual(
      entries
        .map((entry) => [
          ALICE_IDENTITY_ID,
          trashItemPath(entry.id, entry.name),
          entry.name === "dir",
        ])
        .sort(),
    );
    expect(follower.onMoved).not.toHaveBeenCalled();
    // Tags and favorites keep their place, as before.
    expect((await metadata.listFavorites(ALICE_IDENTITY_ID)).map((entry) => entry.path)).toEqual([
      "/dir",
    ]);
  });

  it("fails a purge whose links and shares cannot end, and keeps the item in Trash", async () => {
    const follower = recordingFollower();
    follower.onDeleted.mockRejectedValue(new Error("grants unavailable"));
    const { app, storage, put } = await buildHarness({ follower });
    await put("/dir");
    const [id] = TrashListResponse.parse(
      await readJson(await app.request(ROUTES.trash.list)),
    ).entries.map((entry) => entry.id);

    const res = await app.request(
      ROUTES.trash.purge,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      }),
    );

    expect(res.status).toBe(500);
    // They end before the item does: it waits in Trash for another try.
    expect((await listed(app)).entries.map((entry) => entry.id)).toEqual([id]);
    expect(await storage.stat(trashItemPath(id ?? "", "dir"))).toMatchObject({ kind: "dir" });
    expect(follower.onDeleted).toHaveBeenCalledWith(
      ALICE_IDENTITY_ID,
      trashItemPath(id ?? "", "dir"),
      true,
    );
    expect(follower.onMoved).not.toHaveBeenCalled();
  });
});

describe("personal activity for trash commands", () => {
  async function trashed(h: Harness, path: string) {
    await h.put(path);
    const entry = (await listed(h.app)).entries.find(
      (candidate) => candidate.originalPath === path,
    );
    if (!entry) throw new Error(`expected ${path} in Trash`);
    return entry.id;
  }

  it("records a restore against the trash leaf and the target it actually reached", async () => {
    const h = await buildHarness();
    const id = await trashed(h, "/hello.txt");

    const res = await h.app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id], target: "/recovered.txt" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Activity-Status")).toBe("recorded");
    expect(h.activity.operations).toHaveLength(1);
    expect(h.activity.operations[0]).toMatchObject({
      action: "file.restore",
      requested: {
        path: "/hello.txt",
        trashLeaf: trashItemPath(id, "hello.txt"),
        targetPath: "/recovered.txt",
      },
    });
    expect(h.activity.outcomes).toEqual([
      expect.objectContaining({
        outcome: "success",
        after: { path: "/recovered.txt", kind: "file", size: 11 },
      }),
    ]);
  });

  it("keeps a failed restore out of history as a conflict, not a success", async () => {
    const h = await buildHarness();
    const id = await trashed(h, "/hello.txt");
    await h.storage.upload("/hello.txt", new TextEncoder().encode("occupied"));

    const res = await h.app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      }),
    );

    expect(res.status).toBe(409);
    expect(h.activity.outcomes).toEqual([
      expect.objectContaining({ action: "file.restore", outcome: "conflict" }),
    ]);
  });

  it("records one delete per purged id, keyed to the path the file came from", async () => {
    const h = await buildHarness();
    const first = await trashed(h, "/hello.txt");
    const second = await trashed(h, "/dir");

    const res = await h.app.request(
      ROUTES.trash.purge,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [first, second] }),
      }),
    );

    expect(res.status).toBe(200);
    expect(h.activity.operations.map((row) => [row.action, row.requested.path])).toEqual([
      ["file.delete", "/hello.txt"],
      ["file.delete", "/dir"],
    ]);
    const batches = new Set(h.activity.operations.map((row) => row.batchId));
    expect(batches.size).toBe(1);
    expect(h.activity.outcomes.every((row) => row.outcome === "success")).toBe(true);
  });

  it("records each emptied leaf and one enclosing trash.empty", async () => {
    const h = await buildHarness();
    await trashed(h, "/hello.txt");
    await trashed(h, "/dir");

    const res = await h.app.request(ROUTES.trash.empty, requestedWith({ method: "POST" }));

    expect(res.status).toBe(200);
    expect(h.activity.outcomes.map((row) => [row.action, row.outcome])).toEqual([
      ["file.delete", "success"],
      ["file.delete", "success"],
      ["trash.empty", "success"],
    ]);
    expect(h.activity.outcomes.at(-1)?.after).toEqual({ path: TRASH_PATH, completedCount: 2 });
    const after = TrashListResponse.parse(await readJson(await h.app.request(ROUTES.trash.list)));
    expect(after.entries).toEqual([]);
  });

  it("records partial emptying when a later provider purge fails", async () => {
    const h = await buildHarness();
    await h.put("/hello.txt");
    await h.put("/dir");
    const trash = h.storage.trash;
    if (!trash) throw Error("Expected Trash");
    const purge = trash.purge.bind(trash);
    vi.spyOn(trash, "purge")
      .mockImplementationOnce(purge)
      .mockRejectedValueOnce(new StorageError("forbidden", "denied"));

    const response = await h.app.request(ROUTES.trash.empty, requestedWith({ method: "POST" }));

    expect(response.status).toBe(403);
    expect(h.activity.outcomes.map((row) => [row.action, row.outcome])).toEqual([
      ["file.delete", "success"],
      ["file.delete", "denied"],
      ["trash.empty", "partial"],
    ]);
    expect(h.activity.outcomes.at(-1)?.detail).toEqual({ completedCount: 1, failedCount: 1 });
    expect((await listed(h.app)).entries).toHaveLength(1);
  });

  it("rejects a malformed correlation header before touching Trash", async () => {
    const h = await buildHarness();
    const id = await trashed(h, "/hello.txt");

    const res = await h.app.request(
      ROUTES.trash.purge,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json", "x-fdrive-batch-id": "not-a-uuid" },
        body: JSON.stringify({ ids: [id] }),
      }),
    );

    expect(res.status).toBe(400);
    expect(h.activity.operations).toEqual([]);
    expect((await listed(h.app)).entries).toHaveLength(1);
  });
});

describe("POST /trash/empty", () => {
  it("removes every trash entry", async () => {
    const { app, put } = await buildHarness();
    await put("/hello.txt");
    await put("/dir");

    const res = await app.request(ROUTES.trash.empty, requestedWith({ method: "POST" }));

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(OkResponse.parse({ ok: true }));
    const after = TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
    expect(after.entries).toEqual([]);
  });

  it("ends what followed each emptied item into Trash", async () => {
    const follower = recordingFollower();
    const { app, put } = await buildHarness({ follower });
    await put("/dir");
    await put("/hello.txt");
    const leaves = (await listed(app)).entries.map((entry) => trashItemPath(entry.id, entry.name));

    const res = await app.request(ROUTES.trash.empty, requestedWith({ method: "POST" }));

    expect(res.status).toBe(200);
    expect(follower.onDeleted.mock.calls.map((call) => call[1]).sort()).toEqual(leaves.sort());
  });

  it("empties a Trash of more items than one listing page once held", async () => {
    const { app, storage, activity, put } = await buildHarness();
    const names = Array.from({ length: 120 }, (_, i) => `/many/file-${i}.txt`);
    for (const name of names) {
      await storage.upload(name, new TextEncoder().encode(name), { mkdirParents: true });
      await put(name);
    }

    const res = await app.request(ROUTES.trash.empty, requestedWith({ method: "POST" }));

    expect(res.status).toBe(200);
    expect((await listed(app)).entries).toEqual([]);
    expect(activity.outcomes.at(-1)).toMatchObject({
      action: "trash.empty",
      outcome: "success",
      after: { path: TRASH_PATH, completedCount: names.length },
    });
    expect(await storage.list(TRASH_PATH)).toEqual([]);
  });

  it("empties only what Trash put there, leaving anything else in the Trash folder alone", async () => {
    const { app, storage, put } = await buildHarness();
    await storage.upload(`${TRASH_PATH}/stray.txt`, new TextEncoder().encode("stray"), {
      mkdirParents: true,
    });
    await storage.mkdir(`${TRASH_PATH}/.fdrive-move-v1/file/p/old/v`, { parents: true });
    await put("/hello.txt");

    const res = await app.request(ROUTES.trash.empty, requestedWith({ method: "POST" }));

    expect(res.status).toBe(200);
    expect((await storage.list(TRASH_PATH)).map((entry) => entry.name).sort()).toEqual([
      ".fdrive-move-v1",
      "stray.txt",
    ]);
  });
});

it("keeps the restores made before a later item fails", async () => {
  const { app, storage, put } = await buildHarness();
  await put("/hello.txt");
  const list = TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
  const id = list.entries[0]?.id;
  if (!id) throw new Error("expected trash entry");
  const response = await app.request(
    ROUTES.trash.restore,
    requestedWith({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [id, id] }),
    }),
  );
  expect(response.status).toBe(404);
  expect(await storage.statFile("/hello.txt")).toMatchObject({ size: 11 });
});
