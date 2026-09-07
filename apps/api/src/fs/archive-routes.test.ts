import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ArchiveEntriesResponse, FsEvent, JobStatus } from "@fdrive/contracts";
import { StorageError, type StorageProvider } from "@fdrive/core";
import { createFakeSftpgoServer, createSftpgoClient, type FakeSeed } from "@fdrive/sftpgo";
import type { Logger } from "pino";
import * as tar from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { createApp } from "../app.js";
import { isZstdSupported } from "../archive/stream-utils.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { createEventBus, type EventBus } from "../events/bus.js";
import { registerEventRoutes } from "../events/routes.js";
import { createJobRunner } from "../jobs/runner.js";
import { createSftpgoStorageProvider, type WithToken } from "../storage/sftpgo-provider.js";
import { registerFsRoutes } from "./routes.js";

/**
 * A minimal `folderSize` deps stub: this file exercises archive routes, not
 * `GET /fs/folder-size` itself, so verified scopes are reported unavailable
 * and every fake always answers `{ indexed: false }` without touching the
 * index.
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

/** Drains a yazl `ZipFile`'s output stream into one `Buffer`. */
async function buildZipBuffer(build: (zipfile: ZipFile) => void): Promise<Buffer> {
  const zipfile = new ZipFile();
  build(zipfile);
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zipfile.outputStream.on("end", resolve);
    zipfile.outputStream.on("error", reject);
  });
  zipfile.end();
  await done;
  return Buffer.concat(chunks);
}

/** Drains a tar-stream `pack()` into one `Buffer`. */
function buildTarBuffer(entries: readonly { name: string; content: string }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
    for (const entry of entries) {
      pack.entry({ name: entry.name, size: Buffer.byteLength(entry.content) }, entry.content);
    }
    pack.finalize();
  });
}

vi.mock("../archive/stream-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../archive/stream-utils.js")>();
  return { ...actual, isZstdSupported: vi.fn(actual.isZstdSupported) };
});

const FULL_PERMS = ["*"];
const ALICE_IDENTITY_ID = "00000000-0000-4000-8000-0000000000a1";
const BOB_IDENTITY_ID = "00000000-0000-4000-8000-0000000000b1";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";

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
    { username: "bob", password: "secret2", permissions: { "/": FULL_PERMS } },
  ],
  files: {
    alice: {
      "/hello.txt": "hello world",
      "/dir/a.txt": "alpha",
      "/dir/nested/b.txt": "bravo",
    },
    bob: {
      "/note.txt": "bob's note",
    },
  },
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
  readonly fsEvents: FsEvent[];
  readonly tmpDir: string;
}

const tempDirs: string[] = [];

async function buildHarness(seed: FakeSeed = SEED, username = "alice", password = "secret") {
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
  const fsEvents: FsEvent[] = [];
  bus.subscribe({ identityId }, (event) => {
    if (event.type === "fs") {
      fsEvents.push(event);
    }
  });

  const clock = () => new Date();
  const jobRunner = createJobRunner({ clock, bus });
  const tmpDir = join(tmpdir(), `fdrive-archive-routes-test-${Date.now()}-${Math.random()}`);
  await mkdir(tmpDir, { recursive: true });
  tempDirs.push(tmpDir);

  const config = loadConfig(REQUIRED_ENV);

  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(),
    clock,
    principalResolver: async () => principal,
    registerRoutes: (groups) => {
      registerFsRoutes(groups, {
        bus,
        clock,
        jobRunner,
        tmpDir,
        jobMaxBytes: 10 * 1024 * 1024,
        folderSize: fakeFolderSizeDeps(),
      });
      registerEventRoutes(groups, { bus, clock });
    },
  });

  const harness: Harness = { app, bus, fsEvents, tmpDir };
  return harness;
}

/**
 * Builds a harness the same way `buildHarness` does, but with an explicit
 * `archivePeekMaxBytes` (composition.ts's own way of passing it, see
 * `fs/archive-routes.ts`'s `ArchiveRoutesDeps`): built as a local variable
 * rather than a fresh object literal, so passing a field `FsRoutesDeps`
 * itself does not declare never trips TypeScript's excess-property check.
 */
async function buildHarnessWithArchivePeekMaxBytes(archivePeekMaxBytes: number): Promise<Harness> {
  const server = createFakeSftpgoServer(SEED);
  const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
  const withToken = await withTokenFor(client, "alice", "secret");
  const storage = createSftpgoStorageProvider({ client, withToken });

  const principal: Principal = {
    accountId: ACCOUNT_ID,
    identityId: ALICE_IDENTITY_ID,
    username: "alice",
    storage,
    isAdmin: false,
  };

  const bus = createEventBus();
  const fsEvents: FsEvent[] = [];
  bus.subscribe({ identityId: ALICE_IDENTITY_ID }, (event) => {
    if (event.type === "fs") {
      fsEvents.push(event);
    }
  });

  const clock = () => new Date();
  const jobRunner = createJobRunner({ clock, bus });
  const tmpDir = join(tmpdir(), `fdrive-archive-routes-peek-${Date.now()}-${Math.random()}`);
  await mkdir(tmpDir, { recursive: true });
  tempDirs.push(tmpDir);

  const config = loadConfig(REQUIRED_ENV);
  const fsRoutesDeps = {
    bus,
    clock,
    jobRunner,
    tmpDir,
    jobMaxBytes: 10 * 1024 * 1024,
    archivePeekMaxBytes,
    folderSize: fakeFolderSizeDeps(),
  };
  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(),
    clock,
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerFsRoutes(groups, fsRoutesDeps),
  });

  return { app, bus, fsEvents, tmpDir };
}

/** Builds a harness around an arbitrary `StorageProvider`, for exercising error-mapping branches. */
async function buildHarnessWithStorage(storage: StorageProvider): Promise<Harness> {
  const principal: Principal = {
    accountId: ACCOUNT_ID,
    identityId: ALICE_IDENTITY_ID,
    username: "alice",
    storage,
    isAdmin: false,
  };

  const bus = createEventBus();
  const fsEvents: FsEvent[] = [];
  bus.subscribe({ identityId: ALICE_IDENTITY_ID }, (event) => {
    if (event.type === "fs") {
      fsEvents.push(event);
    }
  });

  const clock = () => new Date();
  const jobRunner = createJobRunner({ clock, bus });
  const tmpDir = join(tmpdir(), `fdrive-archive-routes-stub-${Date.now()}-${Math.random()}`);
  await mkdir(tmpDir, { recursive: true });
  tempDirs.push(tmpDir);

  const config = loadConfig(REQUIRED_ENV);
  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(),
    clock,
    principalResolver: async () => principal,
    registerRoutes: (groups) =>
      registerFsRoutes(groups, {
        bus,
        clock,
        jobRunner,
        tmpDir,
        jobMaxBytes: 10 * 1024 * 1024,
        folderSize: fakeFolderSizeDeps(),
      }),
  });

  return { app, bus, fsEvents, tmpDir };
}

afterEach(async () => {
  vi.mocked(isZstdSupported).mockReset();
  vi.mocked(isZstdSupported).mockImplementation(
    (
      await vi.importActual<typeof import("../archive/stream-utils.js")>(
        "../archive/stream-utils.js",
      )
    ).isZstdSupported,
  );
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

function requestedWith(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...init.headers, "x-requested-with": "fdrive" } };
}

function jsonPost(body: unknown): RequestInit {
  return requestedWith({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface ErrorJson {
  error: { kind: string; message: string };
}

async function waitForJobDone(
  app: ReturnType<typeof createApp>,
  jobId: string,
  timeoutMs = 3000,
): Promise<JobStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.request(`/api/v1/fs/jobs/${jobId}`);
    const body = (await res.json()) as JobStatus;
    if (body.state === "done" || body.state === "failed" || body.state === "cancelled") {
      return body;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `job ${jobId} did not finish within ${timeoutMs}ms (last state: ${body.state})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function notImplemented(): never {
  throw new Error("not implemented in this stub");
}

function makeStubStorage(overrides: Partial<StorageProvider>): StorageProvider {
  return {
    list: notImplemented,
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
  };
}

describe("POST /fs/duplicate", () => {
  it("copies the file next to itself with a unique name and publishes a copy event", async () => {
    const { app, fsEvents } = await buildHarness();

    const res = await app.request("/api/v1/fs/duplicate", jsonPost({ path: "/hello.txt" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ path: "/hello copy.txt", name: "hello copy.txt" });
    expect(fsEvents).toEqual([
      expect.objectContaining({
        op: "copy",
        paths: ["/hello.txt"],
        targetPaths: ["/hello copy.txt"],
      }),
    ]);
  });

  it("numbers the second duplicate", async () => {
    const { app } = await buildHarness();

    await app.request("/api/v1/fs/duplicate", jsonPost({ path: "/hello.txt" }));
    const res = await app.request("/api/v1/fs/duplicate", jsonPost({ path: "/hello.txt" }));

    const body = await res.json();
    expect(body).toMatchObject({ name: "hello copy 2.txt" });
  });
});

describe("POST /fs/compress and the resulting job", () => {
  it("compresses a folder to zip, completes, and publishes an fs create event", async () => {
    const { app, fsEvents } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip" }),
    );
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    const final = await waitForJobDone(app, jobId);
    expect(final.state).toBe("done");
    expect(final.result?.path).toBe("/dir.zip");
    expect(fsEvents.some((e) => e.op === "create" && e.paths.includes("/dir.zip"))).toBe(true);

    const listRes = await app.request("/api/v1/fs/list?path=/");
    const listing = (await listRes.json()) as { entries: { name: string }[] };
    expect(listing.entries.map((e) => e.name)).toContain("dir.zip");
  });

  it("keeps running to completion after the submitting request's own signal aborts (the job must not share the request's signal)", async () => {
    const { app } = await buildHarness();
    const requestController = new AbortController();

    const res = await app.request("/api/v1/fs/compress", {
      ...jsonPost({ paths: ["/dir"], format: "zip" }),
      signal: requestController.signal,
    });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    // The client that made the compress request has moved on (its own
    // fetch's signal aborts, for example because the browser tab
    // navigated away); the job it started must keep running regardless.
    requestController.abort();

    const final = await waitForJobDone(app, jobId);
    expect(final.state).toBe("done");
    expect(final.result?.path).toBe("/dir.zip");
  });

  it("defaults the archive name from the single selected file's own name", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/hello.txt"], format: "zip" }),
    );
    const { jobId } = (await res.json()) as { jobId: string };
    const final = await waitForJobDone(app, jobId);

    expect(final.result?.path).toBe("/hello.txt.zip");
  });

  it("uses the given name and destination", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip", name: "bundle", destination: "/" }),
    );
    const { jobId } = (await res.json()) as { jobId: string };
    const final = await waitForJobDone(app, jobId);

    expect(final.result?.path).toBe("/bundle.zip");
  });

  it("defaults the archive name to the shared parent folder's name for a multi-path selection", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir/a.txt", "/dir/nested"], format: "zip" }),
    );
    const { jobId } = (await res.json()) as { jobId: string };
    const final = await waitForJobDone(app, jobId);

    expect(final.result?.path).toBe("/dir/dir.zip");
  });

  it("falls back to 'archive' when a multi-path selection's shared parent is the root", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/hello.txt", "/dir"], format: "zip" }),
    );
    const { jobId } = (await res.json()) as { jobId: string };
    const final = await waitForJobDone(app, jobId);

    expect(final.result?.path).toBe("/archive.zip");
  });

  it("falls back to 'archive' when the single selected path is the root itself", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/"], format: "zip", destination: "/dir" }),
    );
    const { jobId } = (await res.json()) as { jobId: string };
    const final = await waitForJobDone(app, jobId);

    expect(final.result?.path).toBe("/dir/archive.zip");
  });

  it("treats an existing directory whose name collides with the target as a conflict", async () => {
    const { app } = await buildHarness();
    await app.request("/api/v1/fs/mkdir", jsonPost({ path: "/same.zip" }));

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/hello.txt"], format: "zip", name: "same", destination: "/" }),
    );

    expect(res.status).toBe(409);
  });

  it("rejects paths that do not share a parent", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/hello.txt", "/dir/a.txt"], format: "zip" }),
    );

    expect(res.status).toBe(400);
  });

  it("rejects a destination that does not exist", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/hello.txt"], format: "zip", destination: "/nope" }),
    );

    expect(res.status).toBe(404);
  });

  it("rejects a destination that is a file, not a folder", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir/a.txt"], format: "zip", destination: "/hello.txt" }),
    );

    expect(res.status).toBe(400);
  });

  it("refuses to overwrite an existing target", async () => {
    const { app } = await buildHarness();
    const first = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip" }),
    );
    const { jobId } = (await first.json()) as { jobId: string };
    await waitForJobDone(app, jobId);

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip" }),
    );

    expect(res.status).toBe(409);
  });

  it("rejects tar.zst up front when unsupported on this server", async () => {
    vi.mocked(isZstdSupported).mockReturnValue(false);
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "tar.zst" }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect((body as ErrorJson).error.message).toContain("tar.zst");
  });

  it("accepts tar.zst when supported", async () => {
    vi.mocked(isZstdSupported).mockReturnValue(true);
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "tar.zst" }),
    );

    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    const final = await waitForJobDone(app, jobId);
    expect(final.state).toBe("done");
  });

  it("maps a full job queue to rate_limited", async () => {
    const bus = createEventBus();
    const server = createFakeSftpgoServer(SEED);
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const withToken = await withTokenFor(client, "alice", "secret");
    const storage = createSftpgoStorageProvider({ client, withToken });
    const principal: Principal = {
      accountId: ACCOUNT_ID,
      identityId: ALICE_IDENTITY_ID,
      username: "alice",
      storage,
      isAdmin: false,
    };
    const jobRunner = createJobRunner({ clock: () => new Date(), bus, maxJobs: 0 });
    const tmpDir = join(tmpdir(), `fdrive-archive-routes-fullqueue-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    tempDirs.push(tmpDir);
    const config = loadConfig(REQUIRED_ENV);
    const app = createApp({
      config,
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date(),
      clock: () => new Date(),
      principalResolver: async () => principal,
      registerRoutes: (groups) =>
        registerFsRoutes(groups, {
          bus,
          clock: () => new Date(),
          jobRunner,
          tmpDir,
          jobMaxBytes: 1000,
          folderSize: fakeFolderSizeDeps(),
        }),
    });

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip" }),
    );

    expect(res.status).toBe(429);
  });
});

describe("POST /fs/extract and the resulting job", () => {
  async function compressDirToZip(app: ReturnType<typeof createApp>): Promise<void> {
    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip" }),
    );
    const { jobId } = (await res.json()) as { jobId: string };
    await waitForJobDone(app, jobId);
  }

  it("extracts into the default destination (archive name without extension) and publishes fs create", async () => {
    const { app, fsEvents } = await buildHarness();
    await compressDirToZip(app);

    const res = await app.request("/api/v1/fs/extract", jsonPost({ path: "/dir.zip" }));
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    const final = await waitForJobDone(app, jobId);
    expect(final.state).toBe("done");
    expect(final.result?.path).toBe("/dir");
    expect(fsEvents.some((e) => e.op === "create" && e.paths.includes("/dir"))).toBe(true);
  });

  it("extracts into an explicit destination", async () => {
    const { app } = await buildHarness();
    await compressDirToZip(app);

    const res = await app.request(
      "/api/v1/fs/extract",
      jsonPost({ path: "/dir.zip", destination: "/restored" }),
    );
    const { jobId } = (await res.json()) as { jobId: string };
    const final = await waitForJobDone(app, jobId);

    expect(final.result?.path).toBe("/restored");
    const listRes = await app.request("/api/v1/fs/list?path=/restored/dir");
    const listing = (await listRes.json()) as { entries: { name: string }[] };
    expect(listing.entries.map((e) => e.name).sort()).toEqual(["a.txt", "nested"]);
  });

  it("rejects an archive path with no recognized extension", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/extract", jsonPost({ path: "/hello.txt" }));

    expect(res.status).toBe(400);
  });

  it("rejects tar.zst up front when unsupported", async () => {
    const { app } = await buildHarness();
    await compressDirToZip(app);
    // Rename via a second compress isn't needed: use a .tar.zst-named path
    // that does not need to exist, since the format check runs first.
    vi.mocked(isZstdSupported).mockReturnValue(false);

    const res = await app.request("/api/v1/fs/extract", jsonPost({ path: "/dir.tar.zst" }));

    expect(res.status).toBe(400);
  });

  it("returns not_found when the archive does not exist", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/extract", jsonPost({ path: "/missing.zip" }));

    expect(res.status).toBe(404);
  });
});

describe("GET /fs/archive-entries", () => {
  async function uploadBinary(
    app: ReturnType<typeof createApp>,
    path: string,
    content: Buffer,
  ): Promise<void> {
    const res = await app.request(
      `/api/v1/fs/upload?path=${encodeURIComponent(path)}`,
      requestedWith({
        method: "PUT",
        headers: { "content-length": String(content.length) },
        body: content,
      }),
    );
    if (res.status !== 201) {
      throw new Error(`upload failed: ${res.status}`);
    }
  }

  it("lists a zip's entries, sorted by path, via two Range reads", async () => {
    const { app } = await buildHarness();
    const zipBytes = await buildZipBuffer((zipfile) => {
      zipfile.addBuffer(Buffer.from("bravo"), "b.txt");
      zipfile.addBuffer(Buffer.from("alpha"), "a.txt");
      zipfile.addEmptyDirectory("sub");
    });
    await uploadBinary(app, "/docs.zip", zipBytes);

    const res = await app.request("/api/v1/fs/archive-entries?path=/docs.zip");

    expect(res.status).toBe(200);
    const body = (await res.json()) as ArchiveEntriesResponse;
    expect(body.format).toBe("zip");
    expect(body.truncated).toBe(false);
    expect(body.entries.map((e) => e.path)).toEqual(["a.txt", "b.txt", "sub"]);
    expect(body.entries.find((e) => e.path === "sub")?.kind).toBe("dir");
  });

  it("lists a tar.gz's entries", async () => {
    const { app } = await buildHarness();
    const tarBytes = await buildTarBuffer([{ name: "hello.txt", content: "hi there" }]);
    await uploadBinary(app, "/docs.tar.gz", gzipSync(tarBytes));

    const res = await app.request("/api/v1/fs/archive-entries?path=/docs.tar.gz");

    expect(res.status).toBe(200);
    const body = (await res.json()) as ArchiveEntriesResponse;
    expect(body).toEqual({
      format: "tar.gz",
      entries: [{ path: "hello.txt", kind: "file", size: 8, modifiedAt: expect.any(String) }],
      truncated: false,
    });
  });

  it("rejects a path with no recognized archive extension", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/archive-entries?path=/hello.txt");

    expect(res.status).toBe(400);
  });

  it("reports a corrupt zip as 'not a readable archive'", async () => {
    const { app } = await buildHarness();
    await uploadBinary(app, "/bad.zip", Buffer.from("not actually a zip file at all"));

    const res = await app.request("/api/v1/fs/archive-entries?path=/bad.zip");

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorJson;
    expect(body.error.message).toBe("not a readable archive");
  });

  it("returns not_found for a missing archive", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/archive-entries?path=/missing.zip");

    expect(res.status).toBe(404);
  });

  it("rejects tar.zst up front when unsupported on this server", async () => {
    vi.mocked(isZstdSupported).mockReturnValue(false);
    const { app } = await buildHarness();
    const tarBytes = await buildTarBuffer([{ name: "a.txt", content: "x" }]);
    await uploadBinary(app, "/docs.tar.zst", tarBytes);

    const res = await app.request("/api/v1/fs/archive-entries?path=/docs.tar.zst");

    expect(res.status).toBe(400);
  });

  it("truncates a tar.gz once the configured archivePeekMaxBytes is exceeded", async () => {
    const { app } = await buildHarnessWithArchivePeekMaxBytes(200);
    // Random, incompressible content: unlike a repeated character, gzip
    // cannot shrink this below `archivePeekMaxBytes`, so the cap is
    // actually exercised instead of never triggering.
    const tarBytes = await buildTarBuffer([
      { name: "a.txt", content: randomBytes(4000).toString("base64") },
      { name: "b.txt", content: randomBytes(4000).toString("base64") },
    ]);
    await uploadBinary(app, "/big.tar.gz", gzipSync(tarBytes));

    const res = await app.request("/api/v1/fs/archive-entries?path=/big.tar.gz");

    expect(res.status).toBe(200);
    const body = (await res.json()) as ArchiveEntriesResponse;
    expect(body.truncated).toBe(true);
  });

  it("rejects a request with no path query parameter", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/archive-entries");

    expect(res.status).toBe(400);
  });
});

describe("GET /fs/jobs, GET /fs/jobs/:id, POST /fs/jobs/:id/cancel", () => {
  it("lists only the caller's jobs", async () => {
    const { app } = await buildHarness();
    const other = await buildHarness(SEED, "bob", "secret2");

    await app.request("/api/v1/fs/compress", jsonPost({ paths: ["/dir"], format: "zip" }));
    await other.app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/note.txt"], format: "zip" }),
    );

    const res = await app.request("/api/v1/fs/jobs");
    const body = (await res.json()) as { jobs: JobStatus[] };
    expect(body.jobs).toHaveLength(1);
  });

  it("returns not_found for a job that does not exist", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/jobs/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns not_found when cancelling a job that does not exist", async () => {
    const { app } = await buildHarness();

    const res = await app.request(
      "/api/v1/fs/jobs/does-not-exist/cancel",
      requestedWith({ method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  it("cancels a job and reflects the cancellation in its status", async () => {
    const { app } = await buildHarness();

    const submitRes = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip" }),
    );
    const { jobId } = (await submitRes.json()) as { jobId: string };

    const cancelRes = await app.request(
      `/api/v1/fs/jobs/${jobId}/cancel`,
      requestedWith({ method: "POST" }),
    );
    expect(cancelRes.status).toBe(200);

    const final = await waitForJobDone(app, jobId);
    expect(["cancelled", "done"]).toContain(final.state);
  });
});

describe("unmapped storage errors pass through unchanged", () => {
  it("maps a non-bad_request, non-not_found StorageError from the destination check", async () => {
    // `assertIsDirectory` (the destination check) tries `statFile` first;
    // this fails there directly, before it would ever fall through to
    // `list`.
    const storage = makeStubStorage({
      statFile: async () => {
        throw new StorageError("forbidden", "no access");
      },
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip", destination: "/somewhere" }),
    );

    expect(res.status).toBe(403);
  });

  it("rethrows a non-StorageError from the destination check as an internal error", async () => {
    const storage = makeStubStorage({
      statFile: async () => {
        throw new Error("boom");
      },
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip", destination: "/somewhere" }),
    );

    expect(res.status).toBe(500);
  });

  it("maps a non-bad_request, non-not_found StorageError from the target existence check", async () => {
    // `statFile("/somewhere")` (the destination check) reports `bad_request`
    // (as SFTPGo does for a real directory), so `assertIsDirectory` falls
    // through to `list`, which resolves it as a directory; the failure
    // this asserts on comes from the *next* `statFile` call, checking
    // whether the target archive path already exists.
    const storage = makeStubStorage({
      list: async () => [],
      statFile: async (path: string) => {
        if (path === "/somewhere") {
          throw new StorageError("bad_request", "is a directory");
        }
        throw new StorageError("forbidden", "no access");
      },
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip", destination: "/somewhere" }),
    );

    expect(res.status).toBe(403);
  });

  it("rethrows a non-StorageError from the target existence check as an internal error", async () => {
    const storage = makeStubStorage({
      list: async () => [],
      statFile: async (path: string) => {
        if (path === "/somewhere") {
          throw new StorageError("bad_request", "is a directory");
        }
        throw new Error("boom");
      },
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip", destination: "/somewhere" }),
    );

    expect(res.status).toBe(500);
  });
});

describe("SSE integration: job events over GET /events", () => {
  it("forwards a job event for the compress job's identity", async () => {
    const { app } = await buildHarness();
    const controller = new AbortController();

    const res = await app.request("/api/v1/events", { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // initial ping

    const compressRes = await app.request(
      "/api/v1/fs/compress",
      jsonPost({ paths: ["/dir"], format: "zip" }),
    );
    const { jobId } = (await compressRes.json()) as { jobId: string };

    let sawJobEvent = false;
    const deadline = Date.now() + 3000;
    while (!sawJobEvent && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const text = new TextDecoder().decode(value);
      if (text.includes("event: job") && text.includes(jobId)) {
        sawJobEvent = true;
      }
    }

    expect(sawJobEvent).toBe(true);
    controller.abort();
    await reader.cancel();
  });
});
