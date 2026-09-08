import {
  OkResponse,
  ROUTES,
  TrashListResponse,
  TrashRestoreResponse,
  TrashStatusResponse,
} from "@fdrive/contracts";
import { normalizePath, StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createFakeSftpgoServer, createSftpgoClient, type FakeSeed } from "@fdrive/sftpgo";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { withRecycleFolderTrash } from "../auth/storage-factory.ts";
import { loadConfig } from "../config.js";
import { type BusEvent, createEventBus, type EventBus } from "../events/bus.js";
import { createMetadataService, type MetadataService } from "../metadata/service.js";
import { createSftpgoStorageProvider, type WithToken } from "../storage/sftpgo-provider.js";
import { registerTrashRoutes, type TrashRoutesDeps } from "./routes.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  SFTPGO_URL: "http://localhost:8080",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const ALICE_IDENTITY_ID = "00000000-0000-4000-8000-0000000000a1";
const BOB_IDENTITY_ID = "00000000-0000-4000-8000-0000000000b1";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const CLOCK_ISO = "2024-06-01T00:00:00.000Z";
const TRASH_PATH = "/.trash";
const PROVIDER_ID = "123e4567-e89b-42d3-a456-426614174000";

function trashSettings(path: string | null, retentionHours: number | null = null) {
  return {
    providerId: PROVIDER_ID,
    revision: 1,
    enabled: path !== null,
    path: path ?? TRASH_PATH,
    retentionHours,
    rulesConfirmed: path !== null,
  } as const;
}

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

const SEED: FakeSeed = {
  users: [
    { username: "alice", password: "secret", permissions: { "/": ["*"] } },
    { username: "bob", password: "secret2", permissions: { "/": ["*"] } },
  ],
  files: {
    alice: {
      "/hello.txt": "hello world",
      "/dir/nested.txt": "nested contents",
    },
    bob: {
      "/bob.txt": "bob's file",
    },
  },
  trash: { path: TRASH_PATH },
};

async function withTokenFor(
  client: ReturnType<typeof createSftpgoClient>,
  username: string,
  password: string,
): Promise<WithToken> {
  const token = await client.login({ username, password });
  return async (fn) => fn(token.accessToken);
}

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly bus: EventBus;
  readonly events: BusEvent[];
  readonly storage: StorageProvider;
  readonly metadata: MetadataService;
}

async function buildHarness(
  opts: {
    seed?: FakeSeed;
    username?: string;
    password?: string;
    withTrash?: boolean;
    trashPathOverride?: string | null;
    retentionHours?: number | null;
    identityId?: string;
  } = {},
): Promise<Harness> {
  const seed = opts.seed ?? SEED;
  const username = opts.username ?? "alice";
  const password = opts.password ?? "secret";
  const withTrash = opts.withTrash ?? true;
  const server = createFakeSftpgoServer(seed);
  const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
  const withToken = await withTokenFor(client, username, password);
  const baseStorage = createSftpgoStorageProvider({ client, withToken });
  const storage = withTrash ? withRecycleFolderTrash(baseStorage, TRASH_PATH) : baseStorage;

  const identityId =
    opts.identityId ?? (username === "alice" ? ALICE_IDENTITY_ID : BOB_IDENTITY_ID);
  const principal: Principal = {
    accountId: ACCOUNT_ID,
    identityId,
    username,
    storage,
    isAdmin: false,
  };

  const bus = createEventBus();
  const events: BusEvent[] = [];
  bus.subscribe({ identityId }, (event) => events.push(event));

  const config = loadConfig(REQUIRED_ENV);
  const clock = () => new Date(CLOCK_ISO);
  const metadata = createMetadataService(createMemoryRepos());

  const deps: TrashRoutesDeps = {
    bus,
    clock,
    settingsForStorage: () =>
      trashSettings(
        opts.trashPathOverride === undefined
          ? withTrash
            ? TRASH_PATH
            : null
          : opts.trashPathOverride,
        opts.retentionHours ?? null,
      ),
    metadata,
  };

  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(CLOCK_ISO),
    clock,
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerTrashRoutes(groups, deps),
  });

  return { app, bus, events, storage, metadata };
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

describe("GET /trash/status", () => {
  it("reports available with the configured path and retention when the identity's storage has a trash", async () => {
    const { app } = await buildHarness({ retentionHours: 72 });

    const res = await app.request(ROUTES.trash.status);
    expect(res.status).toBe(200);
    const body = TrashStatusResponse.parse(await readJson(res));
    expect(body).toEqual({ available: true, path: TRASH_PATH, retentionHours: 72 });
  });

  it("reports unavailable with a null path and retention when no trash is configured", async () => {
    const { app } = await buildHarness({ withTrash: false, trashPathOverride: null });

    const res = await app.request(ROUTES.trash.status);
    expect(res.status).toBe(200);
    const body = TrashStatusResponse.parse(await readJson(res));
    expect(body).toEqual({ available: false, path: null, retentionHours: null });
  });
});

describe("GET /trash", () => {
  it("returns not_found when the identity's storage has no trash", async () => {
    const { app } = await buildHarness({ withTrash: false, trashPathOverride: null });

    const res = await app.request(ROUTES.trash.list);
    expect(res.status).toBe(404);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.kind).toBe("not_found");
  });

  it("returns not_found when the deployment's trash path is unset even though this identity's storage has one (defensive)", async () => {
    const { app } = await buildHarness({ trashPathOverride: null });

    const res = await app.request(ROUTES.trash.list);
    expect(res.status).toBe(404);
  });

  it("lists a deleted file and a deleted directory's files, with parsed originalPath, name, and deletedAt", async () => {
    const { app, storage } = await buildHarness();
    await storage.deleteFile("/hello.txt");
    await storage.deleteDir("/dir");

    const res = await app.request(ROUTES.trash.list);
    expect(res.status).toBe(200);
    const body = TrashListResponse.parse(await readJson(res));
    expect(body.truncated).toBe(false);
    const byName = new Map(body.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("hello.txt")).toMatchObject({
      originalPath: "/hello.txt",
      name: "hello.txt",
    });
    expect(byName.get("nested.txt")).toMatchObject({
      originalPath: "/dir/nested.txt",
      name: "nested.txt",
    });
    expect(new Date(byName.get("hello.txt")?.deletedAt ?? "").toString()).not.toBe("Invalid Date");
  });

  it("keeps a second user's trash isolated from the first", async () => {
    const alice = await buildHarness();
    await alice.storage.deleteFile("/hello.txt");
    const bob = await buildHarness({ username: "bob", password: "secret2" });
    await bob.storage.deleteFile("/bob.txt");

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
  it("restores to the original path, decorates metadata, and publishes one move event", async () => {
    const { app, storage, metadata, events } = await buildHarness();
    await storage.deleteFile("/hello.txt");
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
    expect(onMovedSpy).toHaveBeenCalledWith(
      ALICE_IDENTITY_ID,
      normalizePath(`${TRASH_PATH}/${id}`),
      "/hello.txt",
      false,
    );
    expect(events).toEqual([
      {
        type: "fs",
        op: "move",
        identityId: ALICE_IDENTITY_ID,
        paths: [normalizePath(`${TRASH_PATH}/${id}`)],
        targetPaths: ["/hello.txt"],
        at: CLOCK_ISO,
      },
    ]);
    expect(await storage.statFile("/hello.txt")).toMatchObject({ size: 11 });
  });

  it("restores to a new target under a new parent folder", async () => {
    const { app, storage } = await buildHarness();
    await storage.deleteFile("/hello.txt");
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
  });

  it("returns 409 with details.failedId when the restore target already exists, via the real core-provided trash against the fake (not a mocked provider)", async () => {
    const { app, storage } = await buildHarness();
    await storage.deleteFile("/hello.txt");
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
    // The conflict came from `@fdrive/core`'s `createRecycleFolderTrash.restore`, not any
    // pre-restore check of the route's own (the route has none): confirm the target file that
    // was already there is untouched and the trashed leaf is still present.
    const downloaded = await storage.download("/hello.txt");
    expect(await new Response(downloaded.body).text()).toBe("new content");
    const stillTrashed = TrashListResponse.parse(
      await readJson(await app.request(ROUTES.trash.list)),
    );
    expect(stillTrashed.entries.map((entry) => entry.id)).toContain(id);
  });

  it("returns bad_request for an id that does not parse as a trash leaf", async () => {
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

  it("propagates a non-StorageError from trash.restore as an internal error", async () => {
    const boom = new Error("boom");
    const storage: StorageProvider = {
      list: () => Promise.reject(new Error("not implemented")),
      // The route has no pre-restore check of its own (that lives in
      // `@fdrive/core`'s `createRecycleFolderTrash`, exercised separately
      // against the fake below); statFile here is never actually called.
      statFile: () => Promise.reject(new StorageError("not_found", "not found")),
      download: () => Promise.reject(new Error("not implemented")),
      upload: () => Promise.reject(new Error("not implemented")),
      mkdir: () => Promise.reject(new Error("not implemented")),
      move: () => Promise.reject(new Error("not implemented")),
      copy: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      deleteDir: () => Promise.reject(new Error("not implemented")),
      setModifiedAt: () => Promise.reject(new Error("not implemented")),
      zip: () => Promise.reject(new Error("not implemented")),
      trash: {
        list: () => Promise.reject(new Error("not implemented")),
        restore: () => Promise.reject(boom),
        purge: () => Promise.reject(new Error("not implemented")),
        empty: () => Promise.reject(new Error("not implemented")),
      },
    };
    const principal: Principal = {
      accountId: ACCOUNT_ID,
      identityId: ALICE_IDENTITY_ID,
      username: "alice",
      storage,
      isAdmin: false,
    };
    const clock = () => new Date(CLOCK_ISO);
    const deps: TrashRoutesDeps = {
      bus: createEventBus(),
      clock,
      settingsForStorage: () => trashSettings(TRASH_PATH),
    };
    const app = createApp({
      config: loadConfig(REQUIRED_ENV),
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date(CLOCK_ISO),
      clock,
      principalResolver: async () => principal,
      registerRoutes: (groups) => registerTrashRoutes(groups, deps),
    });

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["hello.txt/168176641123456789"] }),
      }),
    );

    expect(res.status).toBe(500);
  });

  it("attaches failedId even when the underlying StorageError carries no details", async () => {
    const storage: StorageProvider = {
      list: () => Promise.reject(new Error("not implemented")),
      // The route has no pre-restore check of its own (that lives in
      // `@fdrive/core`'s `createRecycleFolderTrash`, exercised separately
      // against the fake below); statFile here is never actually called.
      statFile: () => Promise.reject(new StorageError("not_found", "not found")),
      download: () => Promise.reject(new Error("not implemented")),
      upload: () => Promise.reject(new Error("not implemented")),
      mkdir: () => Promise.reject(new Error("not implemented")),
      move: () => Promise.reject(new Error("not implemented")),
      copy: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      deleteDir: () => Promise.reject(new Error("not implemented")),
      setModifiedAt: () => Promise.reject(new Error("not implemented")),
      zip: () => Promise.reject(new Error("not implemented")),
      trash: {
        list: () => Promise.reject(new Error("not implemented")),
        restore: () => Promise.reject(new StorageError("conflict", "already exists")),
        purge: () => Promise.reject(new Error("not implemented")),
        empty: () => Promise.reject(new Error("not implemented")),
      },
    };
    const principal: Principal = {
      accountId: ACCOUNT_ID,
      identityId: ALICE_IDENTITY_ID,
      username: "alice",
      storage,
      isAdmin: false,
    };
    const clock = () => new Date(CLOCK_ISO);
    const deps: TrashRoutesDeps = {
      bus: createEventBus(),
      clock,
      settingsForStorage: () => trashSettings(TRASH_PATH),
    };
    const app = createApp({
      config: loadConfig(REQUIRED_ENV),
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date(CLOCK_ISO),
      clock,
      principalResolver: async () => principal,
      registerRoutes: (groups) => registerTrashRoutes(groups, deps),
    });

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["hello.txt/168176641123456789"] }),
      }),
    );

    expect(res.status).toBe(409);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.details).toEqual({ failedId: "hello.txt/168176641123456789" });
  });

  it("succeeds without calling any metadata hook when no metadata service is configured", async () => {
    const { storage } = await buildHarness();
    await storage.deleteFile("/hello.txt");
    const trashList = await storage.trash?.list();
    const id = trashList?.entries[0]?.id;
    if (id === undefined) throw new Error("expected a trash entry");

    const principal: Principal = {
      accountId: ACCOUNT_ID,
      identityId: ALICE_IDENTITY_ID,
      username: "alice",
      storage,
      isAdmin: false,
    };
    const clock = () => new Date(CLOCK_ISO);
    const deps: TrashRoutesDeps = {
      bus: createEventBus(),
      clock,
      settingsForStorage: () => trashSettings(TRASH_PATH),
    };
    const app = createApp({
      config: loadConfig(REQUIRED_ENV),
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date(CLOCK_ISO),
      clock,
      principalResolver: async () => principal,
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

    expect(res.status).toBe(200);
    const body = TrashRestoreResponse.parse(await readJson(res));
    expect(body.restored[0]?.path).toBe("/hello.txt");
  });

  it("returns not_found when the identity's storage has no trash", async () => {
    const { app } = await buildHarness({ withTrash: false, trashPathOverride: null });

    const res = await app.request(
      ROUTES.trash.restore,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["a.txt/168176641123456789"] }),
      }),
    );

    expect(res.status).toBe(404);
  });
});

describe("POST /trash/purge", () => {
  it("permanently removes the given ids and publishes one delete event", async () => {
    const { app, storage, events } = await buildHarness();
    await storage.deleteFile("/hello.txt");
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
    expect(events).toEqual([
      {
        type: "fs",
        op: "delete",
        identityId: ALICE_IDENTITY_ID,
        paths: [normalizePath(`${TRASH_PATH}/${id}`)],
        at: CLOCK_ISO,
      },
    ]);
    const after = TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
    expect(after.entries).toEqual([]);
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

  it("returns not_found when the identity's storage has no trash", async () => {
    const { app } = await buildHarness({ withTrash: false, trashPathOverride: null });

    const res = await app.request(
      ROUTES.trash.purge,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["a.txt/168176641123456789"] }),
      }),
    );

    expect(res.status).toBe(404);
  });
});

describe("POST /trash/empty", () => {
  it("removes every trash entry and publishes one delete event for the trash folder", async () => {
    const { app, storage, events } = await buildHarness();
    await storage.deleteFile("/hello.txt");
    await storage.deleteDir("/dir");

    const res = await app.request(ROUTES.trash.empty, requestedWith({ method: "POST" }));

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(OkResponse.parse({ ok: true }));
    expect(events).toEqual([
      {
        type: "fs",
        op: "delete",
        identityId: ALICE_IDENTITY_ID,
        paths: [TRASH_PATH],
        at: CLOCK_ISO,
      },
    ]);
    const after = TrashListResponse.parse(await readJson(await app.request(ROUTES.trash.list)));
    expect(after.entries).toEqual([]);
  });

  it("returns not_found when the identity's storage has no trash", async () => {
    const { app } = await buildHarness({ withTrash: false, trashPathOverride: null });

    const res = await app.request(ROUTES.trash.empty, requestedWith({ method: "POST" }));
    expect(res.status).toBe(404);
  });
});
