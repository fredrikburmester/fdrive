import { createServer } from "node:http";
import type { MoveManyResponse } from "@fdrive/contracts";
import { StorageError, type StorageProvider, withMoveToTrash } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { createMemoryRepos } from "@fdrive/db/testing";
import {
  createFakeSftpgoServer,
  createSftpgoClient,
  createSftpgoStorageProvider,
  type FakeSeed,
  type WithToken,
} from "@fdrive/sftpgo";
import { getRequestListener } from "@hono/node-server";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { activityFixture } from "../../test/activity-fixture.js";
import { captureRecycleReceipt } from "../activity/trash.js";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { withRecycleFolderTrash } from "../auth/storage-factory.ts";
import { loadConfig } from "../config.js";
import { type BusEvent, createEventBus, type EventBus } from "../events/bus.js";
import { createJobRunner, type JobRunner } from "../jobs/runner.js";
import { createMetadataService, type MetadataService } from "../metadata/service.js";
import { type FsRoutesDeps, registerFsRoutes, requireTargetFree, trashMany } from "./routes.js";

function buildJobRunner(): JobRunner {
  return createJobRunner({
    clock: () => new Date("2024-06-01T00:00:00.000Z"),
    bus: createEventBus(),
  });
}

/**
 * A minimal `folderSize` deps stub for tests in this file that exercise
 * other `fs` routes, not `GET /fs/folder-size` itself (see
 * `folder-size.test.ts` for that route's own coverage): reports the
 * caller's verified index scopes as unavailable, so the route always
 * answers `{ indexed: false }` without ever touching the fakes below.
 */
function fakeFolderSizeDeps() {
  return {
    indexQueries: {
      rootIdsByName: async () => ({}),
      subtreeSize: async () => ({ bytes: 0, files: 0 }),
    },
    resolver: {
      verifiedIndexScopes: async () => ({ available: false as const, reason: "no_roots" as const }),
    },
    identities: { get: async () => null },
  };
}

const FULL_PERMS = ["*"];

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  SFTPGO_URL: "http://localhost:8080",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

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
    { username: "alice", password: "secret", permissions: { "/": FULL_PERMS } },
    { username: "bob", password: "secret2", permissions: { "/": [] } },
  ],
  files: {
    alice: {
      "/hello.txt": "hello world",
      "/dir/nested.txt": "nested contents",
    },
  },
};

const ALICE_IDENTITY_ID = "00000000-0000-4000-8000-0000000000a1";
const BOB_IDENTITY_ID = "00000000-0000-4000-8000-0000000000b1";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const CLOCK_ISO = "2024-06-01T00:00:00.000Z";

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
  readonly activity: ReturnType<typeof activityFixture>;
}

async function buildHarness(
  seed: FakeSeed = SEED,
  username = "alice",
  password = "secret",
  metadata?: MetadataService,
  activityObservations?: FsRoutesDeps["activityObservations"],
) {
  const server = createFakeSftpgoServer(seed);
  const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
  const withToken = await withTokenFor(client, username, password);
  const storage = createSftpgoStorageProvider({ client, withToken });

  const identityId = username === "alice" ? ALICE_IDENTITY_ID : BOB_IDENTITY_ID;
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
  const activity = activityFixture(clock);

  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(CLOCK_ISO),
    clock,
    principalResolver: async () => principal,
    registerRoutes: (groups) =>
      registerFsRoutes(groups, {
        activity: activity.service,
        bus,
        clock,
        jobRunner: buildJobRunner(),
        tmpDir: "/tmp",
        jobMaxBytes: 1_000_000_000,
        folderSize: fakeFolderSizeDeps(),
        ...(metadata === undefined ? {} : { metadata }),
        ...(activityObservations === undefined ? {} : { activityObservations }),
      }),
  });

  const harness: Harness = { app, bus, events, activity };
  return harness;
}

function notImplemented(): never {
  throw new Error("not implemented in this fake");
}

function makeStubStorage(overrides: Partial<StorageProvider>): StorageProvider {
  return {
    list: notImplemented,
    stat: notImplemented,
    statFile: notImplemented,
    download: notImplemented,
    upload: notImplemented,
    mkdir: notImplemented,
    move: notImplemented,
    copy: notImplemented,
    deleteFile: notImplemented,
    deleteDir: notImplemented,
    setModifiedAt: notImplemented,
    zip: notImplemented,
    ...overrides,
  } as StorageProvider;
}

function makeDownloadResult(
  overrides: Partial<Awaited<ReturnType<StorageProvider["download"]>>> = {},
): Awaited<ReturnType<StorageProvider["download"]>> {
  return {
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data"));
        controller.close();
      },
    }),
    contentLength: 4,
    contentRange: null,
    contentType: null,
    lastModified: null,
    ...overrides,
  };
}

async function buildHarnessWithStorage(
  storage: StorageProvider,
  opts: { metadata?: MetadataService; trashPath?: string; jsonMaxBytes?: number } = {},
): Promise<Harness> {
  const principal: Principal = {
    accountId: ACCOUNT_ID,
    identityId: ALICE_IDENTITY_ID,
    username: "alice",
    storage,
    isAdmin: false,
  };

  const bus = createEventBus();
  const events: BusEvent[] = [];
  bus.subscribe({ identityId: ALICE_IDENTITY_ID }, (event) => events.push(event));

  const config = loadConfig(REQUIRED_ENV);
  const clock = () => new Date(CLOCK_ISO);
  const activity = activityFixture(clock);

  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(CLOCK_ISO),
    clock,
    principalResolver: async () => principal,
    registerRoutes: (groups) =>
      registerFsRoutes(groups, {
        activity: activity.service,
        bus,
        clock,
        jobRunner: buildJobRunner(),
        tmpDir: "/tmp",
        jobMaxBytes: 1_000_000_000,
        folderSize: fakeFolderSizeDeps(),
        ...(opts.metadata === undefined ? {} : { metadata: opts.metadata }),
        ...(opts.trashPath === undefined
          ? {}
          : { trashPathForStorage: () => opts.trashPath ?? null }),
        ...(opts.jsonMaxBytes === undefined ? {} : { jsonMaxBytes: opts.jsonMaxBytes }),
      }),
  });

  return { app, bus, events, activity };
}

function requestedWith(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...init.headers, "x-requested-with": "fdrive" } };
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface ErrorJson {
  error: {
    kind: string;
    message: string;
    requestId?: string;
    details?: Record<string, unknown>;
  };
}

interface FsEntryJson {
  name: string;
  path: string;
  kind: string;
  size: number;
  ext: string;
  mime: string | null;
}

interface ListJson {
  path: string;
  entries: FsEntryJson[];
}

describe("GET /fs/list", () => {
  it("lists a directory", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/list?path=/");
    expect(res.status).toBe(200);
    const body = await readJson<ListJson>(res);
    expect(body.path).toBe("/");
    const names = body.entries.map((e) => e.name).sort();
    expect(names).toEqual(["dir", "hello.txt"]);
    const file = body.entries.find((e) => e.name === "hello.txt");
    expect(file?.kind).toBe("file");
    expect(file?.mime).toBe("text/plain");
    expect(file?.ext).toBe(".txt");
    const dir = body.entries.find((e) => e.name === "dir");
    expect(dir?.kind).toBe("dir");
    expect(dir?.mime).toBeNull();
  });

  it("answers while history comparison is still probing the provider", async () => {
    // Comparison reaches the provider. A listing never waits for it.
    const { app } = await buildHarness(SEED, "alice", "secret", undefined, {
      refresh: () => new Promise<void>(() => {}),
    } as unknown as FsRoutesDeps["activityObservations"]);

    const res = await app.request("/api/v1/fs/list?path=/");
    expect(res.status).toBe(200);
    expect((await readJson<ListJson>(res)).entries).toHaveLength(2);
  });

  it("returns bad_request when path is missing", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/list");
    expect(res.status).toBe(400);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.kind).toBe("bad_request");
    expect(Array.isArray(body.error.details?.issues)).toBe(true);
  });

  it("omits the trash folder itself when a trashPath is configured", async () => {
    const storage = makeStubStorage({
      list: async () => [
        {
          name: "hello.txt",
          path: "/hello.txt",
          kind: "file",
          size: 1,
          modifiedAt: new Date(0),
          ext: ".txt",
        },
        { name: ".trash", path: "/.trash", kind: "dir", size: 0, modifiedAt: new Date(0), ext: "" },
      ],
    });
    const { app } = await buildHarnessWithStorage(storage, { trashPath: "/.trash" });

    const res = await app.request("/api/v1/fs/list?path=/");
    expect(res.status).toBe(200);
    const body = await readJson<ListJson>(res);
    expect(body.entries.map((e) => e.name)).toEqual(["hello.txt"]);
  });

  it("omits the Mac app's bookkeeping folder even when no trashPath is configured", async () => {
    const storage = makeStubStorage({
      list: async () => [
        {
          name: ".fdrive-desktop",
          path: "/.fdrive-desktop",
          kind: "dir",
          size: 0,
          modifiedAt: new Date(0),
          ext: "",
        },
        {
          name: "hello.txt",
          path: "/hello.txt",
          kind: "file",
          size: 1,
          modifiedAt: new Date(0),
          ext: ".txt",
        },
      ],
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/list?path=/");
    expect(res.status).toBe(200);
    const body = await readJson<ListJson>(res);
    expect(body.entries.map((e) => e.name)).toEqual(["hello.txt"]);
  });

  it("keeps a folder of the same name that is not at the storage root", async () => {
    const storage = makeStubStorage({
      list: async () => [
        {
          name: ".fdrive-desktop",
          path: "/projects/.fdrive-desktop",
          kind: "dir",
          size: 0,
          modifiedAt: new Date(0),
          ext: "",
        },
      ],
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/list?path=/projects");
    expect(res.status).toBe(200);
    const body = await readJson<ListJson>(res);
    expect(body.entries.map((e) => e.name)).toEqual([".fdrive-desktop"]);
  });

  it("keeps every entry, including the configured trash path, when no trashPath is configured", async () => {
    const storage = makeStubStorage({
      list: async () => [
        { name: ".trash", path: "/.trash", kind: "dir", size: 0, modifiedAt: new Date(0), ext: "" },
      ],
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/list?path=/");
    expect(res.status).toBe(200);
    const body = await readJson<ListJson>(res);
    expect(body.entries.map((e) => e.name)).toEqual([".trash"]);
  });

  it("maps a 404 from the provider to not_found", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/list?path=/missing-dir");
    expect(res.status).toBe(404);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.kind).toBe("not_found");
  });

  it("maps a forbidden provider error for a caller without permissions", async () => {
    const { app } = await buildHarness(SEED, "bob", "secret2");

    const res = await app.request("/api/v1/fs/list?path=/");
    expect(res.status).toBe(403);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.kind).toBe("forbidden");
  });

  it("maps an invalid path (embedded NUL byte) to bad_request", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/list?path=%00bad");
    expect(res.status).toBe(400);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.kind).toBe("bad_request");
  });
});

describe("GET /fs/stat", () => {
  it("decorates an authorized stat with this identity's tags and favorites", async () => {
    const repos = createMemoryRepos();
    const metadata = createMetadataService(repos);
    const account = await repos.accounts.create({ displayName: "Alice" });
    const tag = await metadata.createTag(account.id, { name: "Work", color: null });
    await metadata.setFileTags(
      { accountId: account.id, identityId: ALICE_IDENTITY_ID },
      "/hello.txt",
      [tag.id],
    );
    await metadata.addFavorite(ALICE_IDENTITY_ID, "/hello.txt", "file");
    const { app } = await buildHarness(SEED, "alice", "secret", metadata);
    const response = await app.request("/api/v1/fs/stat?path=/hello.txt");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      path: "/hello.txt",
      meta: { tagIds: [tag.id], favorite: true },
    });

    const otherSeed: FakeSeed = {
      users: [{ username: "bob", password: "secret2", permissions: { "/": FULL_PERMS } }],
      files: { bob: { "/hello.txt": "Bob's own file" } },
    };
    const other = await buildHarness(otherSeed, "bob", "secret2", metadata);
    const otherResponse = await other.app.request("/api/v1/fs/stat?path=/hello.txt");
    expect(otherResponse.status).toBe(200);
    expect(await otherResponse.json()).toMatchObject({
      path: "/hello.txt",
      size: 14,
      meta: { tagIds: [], favorite: false },
    });
  });

  it("never looks up metadata when storage denies stat", async () => {
    const metadata = createMetadataService(createMemoryRepos());
    const decorate = vi.spyOn(metadata, "decorate");
    const { app } = await buildHarness(SEED, "bob", "secret2", metadata);
    const response = await app.request("/api/v1/fs/stat?path=/hello.txt");
    expect(response.status).toBe(403);
    expect(decorate).not.toHaveBeenCalled();
  });

  it("stats a file directly", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/stat?path=/hello.txt");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: "hello.txt", path: "/hello.txt", kind: "file", size: 11 });
  });

  it("stats a directory via the parent listing fallback", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/stat?path=/dir");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: "dir", path: "/dir", kind: "dir" });
  });

  it("returns not_found for a missing path", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/stat?path=/nope.txt");
    expect(res.status).toBe(404);
  });

  it("returns bad_request for a missing query param", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/stat");
    expect(res.status).toBe(400);
  });
});

describe("GET/HEAD /fs/download", () => {
  it("downloads a whole file", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/download?path=/hello.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toBe("hello world");
  });

  it("serves a byte range with 206 and a Content-Range header", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/download?path=/hello.txt", {
      headers: { range: "bytes=0-4" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/11");
    expect(await res.text()).toBe("hello");
  });

  it("ignores a valid multi-range request and downloads the whole file", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/download?path=/hello.txt", {
      headers: { range: "bytes=0-1,4-5", "if-range": "stale-validator" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect(await res.text()).toBe("hello world");
  });

  it("returns 416 with Content-Range when the range is out of bounds and the size is known", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/download?path=/hello.txt", {
      headers: { range: "bytes=1000-2000" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */11");
  });

  it("returns 416 with the empty size for a suffix range on an empty file", async () => {
    const download = vi.fn<StorageProvider["download"]>();
    const storage = makeStubStorage({
      statFile: async () => ({ size: 0, modifiedAt: null, contentType: null }),
      download,
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/download?path=/empty.txt", {
      headers: { range: "bytes=-10" },
    });

    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */0");
    expect(download).not.toHaveBeenCalled();
  });

  it("returns a plain 416 when the range is invalid and the size cannot be determined", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/download?path=/does-not-exist.txt", {
      headers: { range: "bytes=10-5,20-30" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBeNull();
  });

  it("responds to HEAD with headers only", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/download?path=/hello.txt", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("11");
    expect(await res.text()).toBe("");
  });

  it("falls back to mimeFromExtension and serves inline when upstream gives no content-type", async () => {
    const storage = makeStubStorage({
      download: async () => makeDownloadResult(),
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/download?path=/hello.txt&inline=1");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-disposition")).toContain("inline");
  });

  it("falls back to application/octet-stream when neither upstream nor the extension has a type", async () => {
    const storage = makeStubStorage({
      download: async () => makeDownloadResult(),
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/download?path=/mystery.xyz");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("falls back to attachment when inline=1 but the type is not previewable", async () => {
    const { app } = await buildHarness({
      ...SEED,
      files: { alice: { "/data.bin": "binary-ish" } },
    });

    const res = await app.request("/api/v1/fs/download?path=/data.bin&inline=1");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("forwards If-Range without erroring", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/download?path=/hello.txt", {
      headers: { "if-range": "some-tag" },
    });
    expect(res.status).toBe(200);
  });

  it("serves an open-ended range (no end) with 206", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/download?path=/hello.txt", {
      headers: { range: "bytes=6-" },
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("world");
  });

  it("maps a missing file (no range) to not_found", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/download?path=/missing.txt");
    expect(res.status).toBe(404);
  });
});

describe("POST /fs/zip", () => {
  it("closes the upstream HTTP request when the client cancels before ZIP headers", async () => {
    let upstreamClosed = false;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const upstream = createServer((request, response) => {
      request.resume();
      response.on("close", () => {
        upstreamClosed = true;
      });
      // Keep headers pending: no response stream exists yet for Hono to cancel.
      markStarted();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (upstreamAddress === null || typeof upstreamAddress === "string")
      throw new Error("no upstream port");
    const client = createSftpgoClient({ baseUrl: `http://127.0.0.1:${upstreamAddress.port}` });
    const storage = createSftpgoStorageProvider({ client, withToken: (fn) => fn("test-token") });
    const { app } = await buildHarnessWithStorage(storage);
    const api = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const apiAddress = api.address();
    if (apiAddress === null || typeof apiAddress === "string") throw new Error("no API port");
    const controller = new AbortController();
    try {
      const result = fetch(
        `http://127.0.0.1:${apiAddress.port}/api/v1/fs/zip`,
        requestedWith({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: ["/hello.txt"] }),
          signal: controller.signal,
        }),
      );
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      await started;
      controller.abort();
      await rejected;
      await vi.waitFor(() => expect(upstreamClosed).toBe(true), { timeout: 2000 });
    } finally {
      controller.abort();
      api.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => api.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    }
  });

  it("forwards request cancellation to storage", async () => {
    let zipSignal: AbortSignal | undefined;
    const storage = makeStubStorage({
      zip: async (_paths, opts) => {
        zipSignal = opts?.signal;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("zip"));
            controller.close();
          },
        });
      },
    });
    const { app } = await buildHarnessWithStorage(storage);
    const controller = new AbortController();

    const res = await app.request(
      "/api/v1/fs/zip",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: ["/hello.txt"] }),
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(200);
    expect(zipSignal?.aborted).toBe(false);

    controller.abort();
    expect(zipSignal?.aborted).toBe(true);
  });

  it("streams a zip named after the request's name", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/zip",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: ["/hello.txt"], name: "archive" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('filename="archive.zip"');
    const bytes = await res.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("derives the zip name from the first path when none is given", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/zip",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: ["/hello.txt"] }),
      }),
    );

    expect(res.headers.get("content-disposition")).toContain('filename="hello.txt.zip"');
  });

  it("falls back to download.zip when the first path has no basename", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/zip",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: ["/"] }),
      }),
    );

    expect(res.headers.get("content-disposition")).toContain('filename="download.zip"');
  });

  it("returns bad_request for an empty paths array", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/zip",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /fs/upload", () => {
  it.each([undefined, "data"])("forwards cancellation for body %s", async (body) => {
    const storage = createMemoryStorage();
    const controller = new AbortController();
    const upload = vi.spyOn(storage, "upload").mockImplementation(async (_path, _body, opts) => {
      expect(opts?.signal).toBeDefined();
      controller.abort();
      expect(opts?.signal?.aborted).toBe(true);
      throw new StorageError("upstream_unavailable", "upload aborted");
    });
    const stat = vi.spyOn(storage, "statFile");
    const { app, events } = await buildHarnessWithStorage(storage);
    const res = await app.request(
      "/api/v1/fs/upload?path=/cancelled.txt",
      requestedWith({
        method: "PUT",
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      }),
    );
    expect(res.ok).toBe(false);
    expect(upload).toHaveBeenCalledOnce();
    expect(stat).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(storage.dump()).toEqual({});
  });

  it("uploads a file, returns 201 with the new entry, and publishes a create event", async () => {
    const { app, events } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/upload?path=/new.txt&mkdirParents=true",
      requestedWith({
        method: "PUT",
        headers: {
          "x-modified-at": String(new Date("2020-01-01T00:00:00.000Z").getTime()),
          "content-length": "4",
        },
        body: "data",
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ path: "/new.txt", size: 4 });
    expect(events).toEqual([
      {
        type: "fs",
        op: "create",
        identityId: ALICE_IDENTITY_ID,
        paths: ["/new.txt"],
        at: CLOCK_ISO,
      },
    ]);
  });

  it("ignores a non-numeric modified-at header", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/upload?path=/another.txt",
      requestedWith({
        method: "PUT",
        headers: { "x-modified-at": "not-a-number" },
        body: "data",
      }),
    );

    expect(res.status).toBe(201);
  });

  it("ignores a non-numeric content-length header", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/upload?path=/bad-length.txt",
      requestedWith({
        method: "PUT",
        headers: { "content-length": "not-a-number" },
        body: "data",
      }),
    );

    expect(res.status).toBe(201);
  });

  it("uploads an empty body when the request has none", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/upload?path=/empty.txt",
      requestedWith({ method: "PUT" }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ path: "/empty.txt", size: 0 });
  });

  it("returns bad_request when path is missing", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/upload",
      requestedWith({ method: "PUT", body: "data" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /fs/mkdir", () => {
  it("creates a directory, returns 201, and publishes a mkdir event", async () => {
    const { app, events } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/mkdir",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/newdir" }),
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ name: "newdir", kind: "dir" });
    expect(events).toEqual([
      { type: "fs", op: "mkdir", identityId: ALICE_IDENTITY_ID, paths: ["/newdir"], at: CLOCK_ISO },
    ]);
  });
});

describe.each(["move", "copy"] as const)("POST /fs/%s subtree safety", (operation) => {
  it.each(["/folder/folder", "/folder/sub/folder", "/folder//sub/folder", "/folder/sub/../folder"])(
    "rejects descendant %s without storage, metadata, or event side effects",
    async (target) => {
      const files = { "/folder/a.txt": "a", "/folder/sub/b.txt": "b" };
      const storage = createMemoryStorage(files);
      const mutate = vi.spyOn(storage, operation);
      const stat = vi.spyOn(storage, "statFile");
      const metadata = createMetadataService(createMemoryRepos());
      const onMoved = vi.spyOn(metadata, "onMoved");
      const onCopied = vi.spyOn(metadata, "onCopied");
      const { app, events } = await buildHarnessWithStorage(storage, { metadata });
      const res = await app.request(
        `/api/v1/fs/${operation}`,
        requestedWith({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "/folder/", target }),
        }),
      );

      expect(res.status).toBe(400);
      expect(mutate).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(onMoved).not.toHaveBeenCalled();
      expect(onCopied).not.toHaveBeenCalled();
      expect(storage.dump()).toEqual(files);
      expect(events).toEqual([]);
    },
  );

  it("allows a similarly prefixed sibling folder", async () => {
    const storage = createMemoryStorage({ "/folder/a.txt": "a" });
    const { app } = await buildHarnessWithStorage(storage);
    const res = await app.request(
      `/api/v1/fs/${operation}`,
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/folder", target: "/folder-other" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(storage.dump()["/folder-other/a.txt"]).toBe("a");
    expect(storage.dump()["/folder/a.txt"]).toBe(operation === "copy" ? "a" : undefined);
  });
});

describe("POST /fs/move", () => {
  it("moves a file, returns the entry at the target, and publishes a move event", async () => {
    const { app, events } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/move",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", target: "/moved.txt" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ path: "/moved.txt" });
    expect(events).toEqual([
      {
        type: "fs",
        op: "move",
        identityId: ALICE_IDENTITY_ID,
        paths: ["/hello.txt"],
        targetPaths: ["/moved.txt"],
        at: CLOCK_ISO,
      },
    ]);
  });

  it("maps a conflicting target to conflict", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/move",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", target: "/dir/nested.txt" }),
      }),
    );

    expect(res.status).toBe(409);
  });

  it("leaves the target's content unchanged when it already exists at the target", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/move",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", target: "/dir/nested.txt" }),
      }),
    );
    expect(res.status).toBe(409);

    const download = await app.request("/api/v1/fs/download?path=/dir/nested.txt");
    expect(await download.text()).toBe("nested contents");
  });

  it("returns 200 when the target is the same path as the source (a no-op)", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/move",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", target: "/hello.txt" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ path: "/hello.txt" });
  });

  it("maps a target that is an existing directory to conflict", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/move",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", target: "/dir" }),
      }),
    );

    expect(res.status).toBe(409);
  });
});

describe("POST /fs/move-many", () => {
  function moveMany(body: unknown): RequestInit {
    return requestedWith({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("moves every item it can, creates missing folders once, and reports each outcome", async () => {
    const storage = createMemoryStorage({
      "/inbox/a.pdf": "a",
      "/inbox/b.pdf": "b",
      "/inbox/c.txt": "c",
      "/notes/c.txt": "taken",
    });
    const mkdir = vi.spyOn(storage, "mkdir");
    const metadata = createMetadataService(createMemoryRepos());
    const onMoved = vi.spyOn(metadata, "onMoved");
    const { app, events } = await buildHarnessWithStorage(storage, { metadata });

    const res = await app.request(
      "/api/v1/fs/move-many",
      moveMany({
        createParents: true,
        items: [
          { path: "/inbox/a.pdf", target: "/Finance/2024/a.pdf" },
          { path: "/inbox/c.txt", target: "/notes/c.txt" },
          { path: "/inbox//b.pdf", target: "/Finance/2024/b.pdf" },
        ],
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { ok: true, path: "/inbox/a.pdf", target: "/Finance/2024/a.pdf" },
        {
          ok: false,
          path: "/inbox/c.txt",
          target: "/notes/c.txt",
          error: { kind: "conflict", message: "something already exists at /notes/c.txt" },
        },
        { ok: true, path: "/inbox/b.pdf", target: "/Finance/2024/b.pdf" },
      ],
    });
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(storage.dump()).toEqual({
      "/Finance/2024/a.pdf": "a",
      "/Finance/2024/b.pdf": "b",
      "/inbox/c.txt": "c",
      "/notes/c.txt": "taken",
    });
    expect(onMoved).toHaveBeenCalledWith(
      ALICE_IDENTITY_ID,
      "/inbox/a.pdf",
      "/Finance/2024/a.pdf",
      false,
    );
    expect(events).toEqual([
      {
        type: "fs",
        op: "mkdir",
        identityId: ALICE_IDENTITY_ID,
        paths: ["/Finance", "/Finance/2024"],
        at: CLOCK_ISO,
      },
      {
        type: "fs",
        op: "move",
        identityId: ALICE_IDENTITY_ID,
        paths: ["/inbox/a.pdf", "/inbox/b.pdf"],
        targetPaths: ["/Finance/2024/a.pdf", "/Finance/2024/b.pdf"],
        at: CLOCK_ISO,
      },
    ]);
  });

  it("reports invalid paths per item and creates no folders unless asked", async () => {
    const storage = createMemoryStorage({ "/inbox/a.pdf": "a", "/inbox/b.pdf": "b" });
    const mkdir = vi.spyOn(storage, "mkdir");
    const { app, events } = await buildHarnessWithStorage(storage);

    const res = await app.request(
      "/api/v1/fs/move-many",
      moveMany({
        items: [
          { path: "/inbox/a\u0000.pdf", target: "/a.pdf" },
          { path: "/inbox/a.pdf", target: "/a.pdf" },
        ],
      }),
    );
    const existingParent = await app.request(
      "/api/v1/fs/move-many",
      moveMany({ createParents: true, items: [{ path: "/inbox/b.pdf", target: "/inbox/c.pdf" }] }),
    );

    expect((await readJson<MoveManyResponse>(res)).results).toEqual([
      {
        ok: false,
        path: "/inbox/a\u0000.pdf",
        target: "/a.pdf",
        error: { kind: "bad_request", message: "path must not contain a NUL byte" },
      },
      { ok: true, path: "/inbox/a.pdf", target: "/a.pdf" },
    ]);
    expect((await readJson<MoveManyResponse>(existingParent)).results).toEqual([
      { ok: true, path: "/inbox/b.pdf", target: "/inbox/c.pdf" },
    ]);
    expect(mkdir).not.toHaveBeenCalled();
    expect(events.map((event) => (event.type === "fs" ? event.op : event.type))).toEqual([
      "move",
      "move",
    ]);
  });

  it("checks the source before creating folders, so a move that cannot happen leaves none", async () => {
    const storage = createMemoryStorage({ "/inbox/a.pdf": "a", "/inbox/sub/b.pdf": "b" });
    const mkdir = vi.spyOn(storage, "mkdir");
    const { app, events } = await buildHarnessWithStorage(storage);

    const res = await app.request(
      "/api/v1/fs/move-many",
      moveMany({
        createParents: true,
        items: [
          { path: "/inbox/gone.pdf", target: "/New/gone.pdf" },
          { path: "/inbox", target: "/inbox/Deeper/inbox" },
          { path: "/inbox/a.pdf", target: "/inbox/a.pdf" },
        ],
      }),
    );

    const results = (await readJson<MoveManyResponse>(res)).results;
    expect(results.map((result) => (result.ok ? "ok" : result.error.kind))).toEqual([
      "not_found",
      "bad_request",
      "ok",
    ]);
    expect(mkdir).not.toHaveBeenCalled();
    expect(storage.dump()).toEqual({ "/inbox/a.pdf": "a", "/inbox/sub/b.pdf": "b" });
    expect(events.map((event) => (event.type === "fs" ? event.op : event.type))).toEqual(["move"]);
  });

  it("maps a storage failure while preparing a folder to that item's error", async () => {
    const storage = createMemoryStorage({ "/inbox/a.pdf": "a" });
    const stat = storage.stat.bind(storage);
    vi.spyOn(storage, "stat").mockImplementation(async (path) => {
      if (path === "/Private") throw new StorageError("forbidden", "no access");
      return stat(path);
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request(
      "/api/v1/fs/move-many",
      moveMany({
        createParents: true,
        items: [{ path: "/inbox/a.pdf", target: "/Private/a.pdf" }],
      }),
    );

    expect((await readJson<MoveManyResponse>(res)).results).toEqual([
      {
        ok: false,
        path: "/inbox/a.pdf",
        target: "/Private/a.pdf",
        error: { kind: "forbidden", message: "no access" },
      },
    ]);
  });

  it("keeps a completed move when its metadata cannot follow, with a warning", async () => {
    const storage = createMemoryStorage({ "/inbox/a.pdf": "a" });
    const metadata = createMetadataService(createMemoryRepos());
    vi.spyOn(metadata, "onMoved").mockRejectedValueOnce(new Error("database down"));
    const { app, events } = await buildHarnessWithStorage(storage, { metadata });

    const res = await app.request(
      "/api/v1/fs/move-many",
      moveMany({ items: [{ path: "/inbox/a.pdf", target: "/a.pdf" }] }),
    );

    expect((await readJson<MoveManyResponse>(res)).results).toEqual([
      {
        ok: true,
        path: "/inbox/a.pdf",
        target: "/a.pdf",
        warning: "Moved, but its tags, favorite or recent entry could not follow it.",
      },
    ]);
    expect(events).toHaveLength(1);
  });

  it("stops on an unexpected failure but still publishes the moves already made", async () => {
    const storage = createMemoryStorage({ "/a.txt": "a", "/b.txt": "b" });
    const move = storage.move.bind(storage);
    vi.spyOn(storage, "move")
      .mockImplementationOnce(move)
      .mockRejectedValueOnce(new Error("socket closed"));
    const { app, events } = await buildHarnessWithStorage(storage);

    const res = await app.request(
      "/api/v1/fs/move-many",
      moveMany({
        items: [
          { path: "/a.txt", target: "/x/a.txt" },
          { path: "/b.txt", target: "/b2.txt" },
        ],
        createParents: true,
      }),
    );

    expect(res.status).toBe(500);
    expect(events).toMatchObject([
      { op: "mkdir", paths: ["/x"] },
      { op: "move", paths: ["/a.txt"], targetPaths: ["/x/a.txt"] },
    ]);
  });
});

describe("requireTargetFree", () => {
  it("maps a non-conflict StorageError from statFile through toApiHttpError", async () => {
    const storage = makeStubStorage({
      statFile: () => Promise.reject(new StorageError("forbidden", "no access")),
    });

    await expect(requireTargetFree(storage, "/blocked.txt")).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("propagates a non-StorageError from statFile unchanged", async () => {
    const boom = new Error("boom");
    const storage = makeStubStorage({ statFile: () => Promise.reject(boom) });

    await expect(requireTargetFree(storage, "/target.txt")).rejects.toBe(boom);
  });
});

describe("POST /fs/copy", () => {
  it("copies a file, returns the entry at the target, and publishes a copy event", async () => {
    const { app, events } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/copy",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", target: "/copy.txt" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ path: "/copy.txt" });
    expect(events).toEqual([
      {
        type: "fs",
        op: "copy",
        identityId: ALICE_IDENTITY_ID,
        paths: ["/hello.txt"],
        targetPaths: ["/copy.txt"],
        at: CLOCK_ISO,
      },
    ]);
  });

  it("maps a conflicting target to conflict, without touching the target's content", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/copy",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", target: "/dir/nested.txt" }),
      }),
    );

    expect(res.status).toBe(409);
    const download = await app.request("/api/v1/fs/download?path=/dir/nested.txt");
    expect(await download.text()).toBe("nested contents");
  });

  it("returns 200 when the target is the same path as the source (a no-op)", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/copy",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", target: "/hello.txt" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ path: "/hello.txt" });
  });
});

describe("POST /fs/rename", () => {
  it("renames a file in place and publishes a move event", async () => {
    const { app, events } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/rename",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", newName: "renamed.txt" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ path: "/renamed.txt", name: "renamed.txt" });
    expect(events).toEqual([
      {
        type: "fs",
        op: "move",
        identityId: ALICE_IDENTITY_ID,
        paths: ["/hello.txt"],
        targetPaths: ["/renamed.txt"],
        at: CLOCK_ISO,
      },
    ]);
  });

  it("returns 200 as a no-op when renaming to the same name", async () => {
    const { app, events } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/rename",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", newName: "hello.txt" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ path: "/hello.txt", name: "hello.txt" });
    expect(events).toEqual([
      {
        type: "fs",
        op: "move",
        identityId: ALICE_IDENTITY_ID,
        paths: ["/hello.txt"],
        targetPaths: ["/hello.txt"],
        at: CLOCK_ISO,
      },
    ]);
  });

  it("maps a rename onto an existing sibling to conflict, without touching either file", async () => {
    const { app } = await buildHarness();
    await app.request(
      "/api/v1/fs/upload?path=%2Fsibling.txt",
      requestedWith({ method: "PUT", body: "sibling content" }),
    );

    const res = await app.request(
      "/api/v1/fs/rename",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", newName: "sibling.txt" }),
      }),
    );

    expect(res.status).toBe(409);
    const helloDownload = await app.request("/api/v1/fs/download?path=/hello.txt");
    expect(await helloDownload.text()).toBe("hello world");
    const siblingDownload = await app.request("/api/v1/fs/download?path=/sibling.txt");
    expect(await siblingDownload.text()).toBe("sibling content");
  });

  it("rejects an invalid new name with bad_request", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/rename",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/hello.txt", newName: "a/b" }),
      }),
    );

    expect(res.status).toBe(400);
  });
});

describe("POST /fs/delete", () => {
  it("deletes files and directories, publishes one delete event, and returns ok", async () => {
    const { app, events } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/delete",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            { path: "/hello.txt", kind: "file" },
            { path: "/dir", kind: "dir" },
          ],
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(events).toEqual([
      {
        type: "fs",
        op: "delete",
        identityId: ALICE_IDENTITY_ID,
        paths: ["/hello.txt", "/dir"],
        at: CLOCK_ISO,
      },
    ]);
  });

  it("stops at the first failure, reports failedPath, and publishes no event", async () => {
    const { app, events } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/delete",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            { path: "/missing.txt", kind: "file" },
            { path: "/hello.txt", kind: "file" },
          ],
        }),
      }),
    );

    expect(res.status).toBe(404);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.details?.failedPath).toBe("/missing.txt");
    expect(events).toEqual([]);
  });

  it("returns bad_request for an empty items array", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/delete",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [] }),
      }),
    );

    expect(res.status).toBe(400);
  });

  it("calls metadata.onTrashed instead of onDeleted when the storage has a trash, but still publishes delete", async () => {
    const server = createFakeSftpgoServer(SEED);
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const withToken = await withTokenFor(client, "alice", "secret");
    const baseStorage = createSftpgoStorageProvider({ client, withToken });
    const storage = withRecycleFolderTrash(baseStorage, "/.trash");
    const metadata = createMetadataService(createMemoryRepos());
    const onTrashedSpy = vi.spyOn(metadata, "onTrashed");
    const onDeletedSpy = vi.spyOn(metadata, "onDeleted");

    const { app, events } = await buildHarnessWithStorage(storage, { metadata });

    const res = await app.request(
      "/api/v1/fs/delete",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ path: "/hello.txt", kind: "file" }] }),
      }),
    );

    expect(res.status).toBe(200);
    expect(onTrashedSpy).toHaveBeenCalledWith(ALICE_IDENTITY_ID, "/hello.txt", false);
    expect(onDeletedSpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        type: "fs",
        op: "delete",
        identityId: ALICE_IDENTITY_ID,
        paths: ["/hello.txt"],
        at: CLOCK_ISO,
      },
    ]);
  });
});

describe("shared body/query parsing", () => {
  it("returns bad_request for invalid JSON", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/mkdir",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(res.status).toBe(400);
  });

  it("returns payload_too_large when the body exceeds the configured jsonMaxBytes cap", async () => {
    const storage = makeStubStorage({});
    const { app } = await buildHarnessWithStorage(storage, { jsonMaxBytes: 10 });

    const res = await app.request(
      "/api/v1/fs/mkdir",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/a-directory-name-longer-than-ten-bytes" }),
      }),
    );

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toMatchObject({ error: { kind: "payload_too_large" } });
  });

  it("accepts a body at or under the configured jsonMaxBytes cap", async () => {
    const storage = makeStubStorage({
      mkdir: async () => undefined,
      stat: async () => ({
        kind: "dir",
        size: 0,
        modifiedAt: new Date(CLOCK_ISO),
        contentType: null,
      }),
    });
    const { app } = await buildHarnessWithStorage(storage, { jsonMaxBytes: 4096 });

    const res = await app.request(
      "/api/v1/fs/mkdir",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/newdir" }),
      }),
    );

    expect(res.status).toBe(201);
  });

  it("defaults to DEFAULT_JSON_MAX_BYTES when jsonMaxBytes is not configured", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/mkdir",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/newdir" }),
      }),
    );

    expect(res.status).toBe(201);
  });
});

describe("unmapped errors pass through unchanged", () => {
  it("rethrows a non-StorageError from a list call as an internal error", async () => {
    const storage = makeStubStorage({
      list: async () => {
        throw new Error("unexpected failure");
      },
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/list?path=/");
    expect(res.status).toBe(500);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.kind).toBe("internal");
  });

  it("rethrows a non-StorageError from statFile as an internal error", async () => {
    const storage = makeStubStorage({
      statFile: async () => {
        throw new Error("unexpected failure");
      },
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/stat?path=/a.txt");
    expect(res.status).toBe(500);
  });

  it("refuses a zip download as unsupported when the storage has no zip", async () => {
    const { zip: _zip, ...withoutZip } = makeStubStorage({});
    const { app } = await buildHarnessWithStorage(withoutZip as StorageProvider);

    const res = await app.request(
      "/api/v1/fs/zip",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: ["/a.txt"] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await readJson<ErrorJson>(res)).toMatchObject({
      error: { kind: "unsupported", details: { capability: "zip" } },
    });
  });

  it("returns not_found when stat reports nothing at the path", async () => {
    const storage = makeStubStorage({
      stat: async () => {
        throw new StorageError("not_found", "not found");
      },
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/stat?path=/dir");
    expect(res.status).toBe(404);
  });

  it("reports a directory from stat with no extension", async () => {
    const storage = makeStubStorage({
      stat: async () => ({ kind: "dir", size: 0, modifiedAt: null, contentType: null }),
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/stat?path=/docs.d");
    expect(res.status).toBe(200);
    expect(await readJson<FsEntryJson>(res)).toMatchObject({ kind: "dir", ext: "" });
  });

  it("maps a StorageError of kind unauthorized to reauth_required", async () => {
    const storage = makeStubStorage({
      list: async () => {
        throw new StorageError("unauthorized", "token expired");
      },
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/list?path=/");
    expect(res.status).toBe(401);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.kind).toBe("reauth_required");
  });

  it("defaults modifiedAt to the epoch when the provider reports none", async () => {
    const storage = makeStubStorage({
      stat: async () => ({ kind: "file", size: 5, modifiedAt: null, contentType: null }),
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/stat?path=/a.txt");
    expect(res.status).toBe(200);
    const body = await readJson<FsEntryJson & { modifiedAt: string }>(res);
    expect(body.modifiedAt).toBe(new Date(0).toISOString());
  });

  it("rethrows a non-StorageError from a delete call as an internal error", async () => {
    const storage = makeStubStorage({
      deleteFile: async () => {
        throw new Error("unexpected failure");
      },
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request(
      "/api/v1/fs/delete",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ path: "/a.txt", kind: "file" }] }),
      }),
    );

    expect(res.status).toBe(500);
  });

  it("reports failedPath without other details when the StorageError carries none", async () => {
    const storage = makeStubStorage({
      deleteFile: async () => {
        throw new StorageError("not_found", "missing");
      },
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request(
      "/api/v1/fs/delete",
      requestedWith({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ path: "/a.txt", kind: "file" }] }),
      }),
    );

    expect(res.status).toBe(404);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.details).toEqual({ failedPath: "/a.txt" });
  });
});

describe("untrusted download documents", () => {
  it.each(["GET", "HEAD"])(
    "forces active content to attachment for %s, including misleading names",
    async (method) => {
      for (const mime of [
        null,
        "text/html; charset=utf-8",
        "image/svg+xml",
        "Text/HTML",
        "text/xml",
        "application/xhtml+xml",
      ]) {
        const storage = makeStubStorage({
          download: async () => makeDownloadResult({ contentType: mime }),
        });
        const { app } = await buildHarnessWithStorage(storage);
        const path = mime === null ? "/attack.html" : "/innocent.txt";
        const response = await app.request(`/api/v1/fs/download?path=${path}&inline=1`, { method });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-disposition")).toContain("attachment");
        expect(response.headers.get("content-security-policy")).toBe("sandbox");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        await response.body?.cancel();
      }
    },
  );
  it("isolates partial responses and preserves passive inline downloads", async () => {
    const storage = makeStubStorage({
      download: async () =>
        makeDownloadResult({
          contentType: "image/svg+xml",
          status: 206,
          contentRange: "bytes 0-3/8",
        }),
    });
    const { app } = await buildHarnessWithStorage(storage);
    const response = await app.request("/api/v1/fs/download?path=/attack.svg&inline=1", {
      headers: { range: "bytes=0-3" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("content-range")).toBe("bytes 0-3/8");
    await response.body?.cancel();
  });
});

it("publishes successful deletes before a later item fails", async () => {
  const { app, events } = await buildHarness();
  const response = await app.request(
    "/api/v1/fs/delete",
    requestedWith({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { path: "/hello.txt", kind: "file" },
          { path: "/missing.txt", kind: "file" },
        ],
      }),
    }),
  );
  expect(response.status).toBe(404);
  expect(events).toEqual([
    expect.objectContaining({ type: "fs", op: "delete", paths: ["/hello.txt"] }),
  ]);
});

describe("trashMany", () => {
  it("removes what it can, continues past failures, and publishes one delete event", async () => {
    const storage = createMemoryStorage({ "/a.txt": "a", "/dir/b.txt": "b" });
    const metadata = createMetadataService(createMemoryRepos());
    const onTrashed = vi.spyOn(metadata, "onTrashed");
    const onDeleted = vi.spyOn(metadata, "onDeleted");
    const bus = createEventBus();
    const events: BusEvent[] = [];
    bus.subscribe({ identityId: ALICE_IDENTITY_ID }, (event) => events.push(event));
    const principal: Principal = {
      accountId: ACCOUNT_ID,
      identityId: ALICE_IDENTITY_ID,
      username: "alice",
      storage,
      isAdmin: false,
    };

    const results = await trashMany(
      { bus, clock: () => new Date(CLOCK_ISO), metadata },
      principal,
      [
        { path: "/a.txt", kind: "file" },
        { path: "/missing.txt", kind: "file" },
        { path: "/dir", kind: "dir" },
      ],
    );

    expect(results).toEqual([
      { path: "/a.txt", ok: true },
      {
        path: "/missing.txt",
        ok: false,
        error: { kind: "not_found", message: expect.any(String) },
      },
      { path: "/dir", ok: true },
    ]);
    // Without a provider Trash the deletes are final, so every metadata row goes.
    expect(onDeleted.mock.calls.map(([, path, isDir]) => [path, isDir])).toEqual([
      ["/a.txt", false],
      ["/dir", true],
    ]);
    expect(onTrashed).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        type: "fs",
        op: "delete",
        identityId: ALICE_IDENTITY_ID,
        paths: ["/a.txt", "/dir"],
        at: CLOCK_ISO,
      },
    ]);
    await expect(storage.stat("/a.txt")).rejects.toMatchObject({ kind: "not_found" });

    vi.spyOn(storage, "deleteFile").mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      trashMany({ bus, clock: () => new Date(CLOCK_ISO), metadata }, principal, [
        { path: "/dir/b.txt", kind: "file" },
      ]),
    ).rejects.toThrow("socket hang up");
  });
});

describe("personal activity for fs commands", () => {
  function jsonPost(body: unknown): RequestInit {
    return requestedWith({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("records each core command with its requested, before and after facts", async () => {
    const { app, activity } = await buildHarness();

    const upload = await app.request(
      "/api/v1/fs/upload?path=/note.txt&intent=save",
      requestedWith({ method: "PUT", body: "hi", headers: { "content-length": "2" } }),
    );
    expect(upload.status).toBe(201);
    expect(upload.headers.get("X-Activity-Status")).toBe("recorded");
    expect(upload.headers.get("X-Activity-Event-Id")).not.toBeNull();

    await app.request("/api/v1/fs/mkdir", jsonPost({ path: "/archive" }));
    await app.request("/api/v1/fs/rename", jsonPost({ path: "/note.txt", newName: "memo.txt" }));
    await app.request("/api/v1/fs/copy", jsonPost({ path: "/memo.txt", target: "/copy.txt" }));
    await app.request("/api/v1/fs/move", jsonPost({ path: "/copy.txt", target: "/archive/c.txt" }));

    expect(activity.operations.map((operation) => operation.action)).toEqual([
      "file.save",
      "folder.create",
      "file.rename",
      "file.copy",
      "file.move",
    ]);
    expect(activity.outcomes.every((outcome) => outcome.outcome === "success")).toBe(true);
    expect(activity.operations[2]).toMatchObject({
      requested: { path: "/note.txt", targetPath: "/memo.txt" },
      before: { path: "/note.txt", kind: "file" },
    });
    expect(activity.outcomes[4]).toMatchObject({ after: { path: "/archive/c.txt", kind: "file" } });
  });

  it("binds the trash leaf fdrive moved the item to", async () => {
    const base = createMemoryStorage();
    await base.upload("/hello.txt", new TextEncoder().encode("hello"));
    const storage = withRecycleFolderTrash(
      withMoveToTrash({
        storage: base,
        trashPath: "/.trash",
        clock: () => new Date(CLOCK_ISO),
        onRecycled: captureRecycleReceipt,
      }),
      "/.trash",
      "move",
    );
    const { app, activity } = await buildHarnessWithStorage(storage, { trashPath: "/.trash" });

    const res = await app.request(
      "/api/v1/fs/delete",
      jsonPost({ items: [{ path: "/hello.txt", kind: "file" }] }),
    );

    expect(res.status).toBe(200);
    expect(activity.operations.at(-1)?.action).toBe("file.trash");
    expect(activity.outcomes.at(-1)?.after).toMatchObject({
      path: "/hello.txt",
      trashStrategy: "fdrive_move",
      trashLeaf: expect.stringContaining("/.trash/"),
    });
  });

  it("records a real delete when the storage has no trash and inside the trash folder", async () => {
    const base = createMemoryStorage();
    await base.upload("/gone.txt", new TextEncoder().encode("x"));
    const plain = await buildHarnessWithStorage(base);
    await plain.app.request(
      "/api/v1/fs/delete",
      jsonPost({ items: [{ path: "/gone.txt", kind: "file" }] }),
    );
    expect(plain.activity.operations.at(-1)?.action).toBe("file.delete");

    const withTrash = createMemoryStorage();
    await withTrash.mkdir("/.trash");
    await withTrash.upload("/.trash/old.txt", new TextEncoder().encode("x"));
    const purge = await buildHarnessWithStorage(withRecycleFolderTrash(withTrash, "/.trash"), {
      trashPath: "/.trash",
    });
    await purge.app.request(
      "/api/v1/fs/delete",
      jsonPost({ items: [{ path: "/.trash/old.txt", kind: "file" }] }),
    );
    expect(purge.activity.operations.at(-1)?.action).toBe("file.delete");
  });

  it("records the failed outcome of a move that never happened", async () => {
    const { app, activity, events } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/move",
      jsonPost({ path: "/missing.txt", target: "/elsewhere.txt" }),
    );

    expect(res.status).toBe(404);
    expect(activity.outcomes.at(-1)).toMatchObject({ outcome: "failed", errorCode: "not_found" });
    expect(events).toEqual([]);
  });

  it("rejects malformed activity correlation headers before touching storage", async () => {
    const { app, activity } = await buildHarness();

    const badOperation = await app.request("/api/v1/fs/mkdir", {
      ...jsonPost({ path: "/x" }),
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fdrive",
        "x-fdrive-operation-id": "not valid",
      },
    });
    const badBatch = await app.request("/api/v1/fs/mkdir", {
      ...jsonPost({ path: "/x" }),
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fdrive",
        "x-fdrive-batch-id": "nope",
      },
    });

    expect([badOperation.status, badBatch.status]).toEqual([400, 400]);
    expect(activity.operations).toEqual([]);
  });

  it("correlates a web batch and reports history that is not written yet", async () => {
    const { app, activity } = await buildHarness();
    const batchId = "00000000-0000-4000-8000-0000000000ba";
    vi.spyOn(activity.service.repo, "finish").mockResolvedValueOnce(undefined as never);

    const res = await app.request("/api/v1/fs/mkdir", {
      ...jsonPost({ path: "/batched" }),
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fdrive",
        "x-fdrive-batch-id": batchId,
        "sec-fetch-site": "same-origin",
      },
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("X-Activity-Status")).toBe("pending");
    expect(res.headers.get("X-Activity-Event-Id")).toBeNull();
    expect(activity.operations.at(-1)).toMatchObject({ source: "web", batchId });
  });

  it("acknowledges a committed upload whose stat fails, and refuses the replay", async () => {
    const base = createMemoryStorage();
    const upload = vi.spyOn(base, "upload");
    const h = await buildHarnessWithStorage({
      ...base,
      stat: async () => {
        throw new StorageError("upstream_unavailable", "offline");
      },
      statFile: async () => {
        throw new StorageError("upstream_unavailable", "offline");
      },
    });
    const options = requestedWith({
      method: "PUT",
      body: "bytes",
      headers: { "x-fdrive-operation-id": "upload-once", "content-length": "5" },
    });

    const response = await h.app.request("/api/v1/fs/upload?path=/a.txt", options);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ path: "/a.txt", size: 5, metadataPending: true });
    expect(h.activity.outcomes.at(-1)).toMatchObject({ action: "file.upload", outcome: "success" });
    expect((await h.app.request("/api/v1/fs/upload?path=/a.txt", options)).status).toBe(409);
    expect(upload).toHaveBeenCalledOnce();
  });
});
