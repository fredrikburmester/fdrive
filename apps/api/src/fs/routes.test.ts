import { StorageError, type StorageProvider } from "@fdrive/core";
import { createFakeSftpgoServer, createSftpgoClient, type FakeSeed } from "@fdrive/sftpgo";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { type BusEvent, createEventBus, type EventBus } from "../events/bus.js";
import { createJobRunner, type JobRunner } from "../jobs/runner.js";
import { createSftpgoStorageProvider, type WithToken } from "../storage/sftpgo-provider.js";
import { registerFsRoutes } from "./routes.js";

function buildJobRunner(): JobRunner {
  return createJobRunner({
    clock: () => new Date("2024-06-01T00:00:00.000Z"),
    bus: createEventBus(),
  });
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
}

async function buildHarness(seed: FakeSeed = SEED, username = "alice", password = "secret") {
  const server = createFakeSftpgoServer(seed);
  const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
  const withToken = await withTokenFor(client, username, password);
  const storage = createSftpgoStorageProvider({ client, withToken });

  const identityId = username === "alice" ? ALICE_IDENTITY_ID : BOB_IDENTITY_ID;
  const principal: Principal = { accountId: ACCOUNT_ID, identityId, username, storage };

  const bus = createEventBus();
  const events: BusEvent[] = [];
  bus.subscribe({ identityId }, (event) => events.push(event));

  const config = loadConfig(REQUIRED_ENV);
  const clock = () => new Date(CLOCK_ISO);

  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(CLOCK_ISO),
    clock,
    principalResolver: async () => principal,
    registerRoutes: (groups) =>
      registerFsRoutes(groups, {
        bus,
        clock,
        jobRunner: buildJobRunner(),
        tmpDir: "/tmp",
        jobMaxBytes: 1_000_000_000,
      }),
  });

  const harness: Harness = { app, bus, events };
  return harness;
}

function notImplemented(): never {
  throw new Error("not implemented in this fake");
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

async function buildHarnessWithStorage(storage: StorageProvider): Promise<Harness> {
  const principal: Principal = {
    accountId: ACCOUNT_ID,
    identityId: ALICE_IDENTITY_ID,
    username: "alice",
    storage,
  };

  const bus = createEventBus();
  const events: BusEvent[] = [];
  bus.subscribe({ identityId: ALICE_IDENTITY_ID }, (event) => events.push(event));

  const config = loadConfig(REQUIRED_ENV);
  const clock = () => new Date(CLOCK_ISO);

  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(CLOCK_ISO),
    clock,
    principalResolver: async () => principal,
    registerRoutes: (groups) =>
      registerFsRoutes(groups, {
        bus,
        clock,
        jobRunner: buildJobRunner(),
        tmpDir: "/tmp",
        jobMaxBytes: 1_000_000_000,
      }),
  });

  return { app, bus, events };
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

  it("returns bad_request when path is missing", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/list");
    expect(res.status).toBe(400);
    const body = await readJson<ErrorJson>(res);
    expect(body.error.kind).toBe("bad_request");
    expect(Array.isArray(body.error.details?.issues)).toBe(true);
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

  it("returns 416 with Content-Range when the range is out of bounds and the size is known", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/download?path=/hello.txt", {
      headers: { range: "bytes=1000-2000" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */11");
  });

  it("returns a plain 416 when the range is invalid and the size cannot be determined", async () => {
    const { app } = await buildHarness();

    const res = await app.request("/api/v1/fs/download?path=/does-not-exist.txt", {
      headers: { range: "bytes=0-10,20-30" },
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

  it("returns not_found when a directory reported via bad_request is missing from its own parent listing", async () => {
    const storage = makeStubStorage({
      statFile: async () => {
        throw new StorageError("bad_request", "is a directory");
      },
      list: async () => [],
    });
    const { app } = await buildHarnessWithStorage(storage);

    const res = await app.request("/api/v1/fs/stat?path=/dir");
    expect(res.status).toBe(404);
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
      statFile: async () => ({ size: 5, modifiedAt: null, contentType: null }),
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
