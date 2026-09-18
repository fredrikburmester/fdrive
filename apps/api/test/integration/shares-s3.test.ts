import { ManagedShare, MeResponse, PublicShare, ShareEntriesResponse } from "@fdrive/contracts";
import { createDb, createRepos } from "@fdrive/db";
import { createS3Client, createS3StorageProvider, s3Module } from "@fdrive/s3";
import { startMinio, startPostgres } from "@fdrive/testkit";
import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { composeApp } from "../../src/composition.ts";
import { loadConfig } from "../../src/config.ts";
import { PROVIDER_MODULES } from "../../src/providers/registry.ts";

const pub = (id: string) => `/api/v1/public/shares/${id}`;
const cookieFrom = (r: Response) => r.headers.get("set-cookie")?.split(";")[0] ?? "";
const text = (body: ReadableStream<Uint8Array>) => new Response(body).text();

/**
 * Owned shares against a real MinIO and PostgreSQL through the composed app.
 * S3 itself still declares `shares: "none"`; the module is injected with
 * `owned` here so the whole path can be proven before that flip. The fetch
 * spy shows every upstream byte going to MinIO and nothing to an SFTPGo
 * endpoint, since there is none.
 */
describe("owned shares over S3 storage", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let minio: Awaited<ReturnType<typeof startMinio>>;
  let app: Awaited<ReturnType<typeof composeApp>>;
  let db: ReturnType<typeof createDb>;
  let providerId: string;
  const upstream: { host: string; path: string }[] = [];
  beforeAll(async () => {
    [postgres, minio] = await Promise.all([startPostgres(), startMinio()]);
    db = createDb(postgres.connectionString);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    app = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        // No SFTPGo in this suite: the row is seeded, never reached.
        SFTPGO_URL: "http://sftpgo.invalid:8080",
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
      }),
      logger,
      () => new Date(),
      {
        fetch: async (input, init) => {
          const req = new Request(input, init);
          const url = new URL(req.url);
          upstream.push({ host: url.host, path: url.pathname });
          return fetch(req);
        },
        modules: {
          ...PROVIDER_MODULES,
          s3: {
            ...s3Module,
            capabilities: { ...s3Module.capabilities, shares: true },
            shares: "owned",
          },
        },
      },
    );
    const repos = createRepos(db.db);
    const row = await repos.providers.ensure({ type: "s3", baseUrl: minio.baseUrl });
    await repos.providers.update(row.id, {
      enabled: true,
      label: "Photos",
      config: { ...row.config, region: "us-east-1" },
    });
    providerId = row.id;
    const storage = createS3StorageProvider({
      client: async () =>
        createS3Client({
          endpoint: minio.endpoint,
          region: "us-east-1",
          credential: minio.writer,
          fetch: globalThis.fetch,
        }),
      bucket: minio.bucket,
      prefix: "",
    });
    await storage.upload("/doc.txt", new TextEncoder().encode("original content"));
    await storage.upload("/folder/a.txt", new TextEncoder().encode("child content"));
  }, 180000);
  afterAll(async () => {
    await app?.close();
    await db?.close();
    await minio?.stop();
    await postgres?.stop();
  }, 180000);
  async function call(
    path: string,
    options: {
      cookie?: string;
      method?: string;
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    return app.app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined
        ? options.raw === undefined
          ? {}
          : { body: options.raw }
        : { body: JSON.stringify(options.body) }),
    });
  }
  async function login() {
    const res = await call("/api/v1/auth/login", {
      method: "POST",
      body: {
        providerId,
        credential: { username: minio.writer.accessKeyId, password: minio.writer.secretAccessKey },
      },
    });
    expect(res.status).toBe(200);
    const me = MeResponse.parse(await res.json());
    expect(me.identities[0]).toMatchObject({ providerType: "s3", capabilities: { shares: true } });
    return cookieFrom(res);
  }
  async function create(cookie: string, body: Record<string, unknown>) {
    const res = await call("/api/v1/shares", {
      method: "POST",
      cookie,
      body: { name: "Document", paths: ["/doc.txt"], scope: "read", ...body },
    });
    expect(res.status).toBe(201);
    return ManagedShare.parse(await res.json());
  }
  async function metadata(id: string, cookie?: string) {
    return PublicShare.parse(
      await (await call(pub(id), cookie === undefined ? {} : { cookie })).json(),
    );
  }

  it("serves a password-protected file: eager password check, ranges, HEAD and the limit", async () => {
    const owner = await login();
    const share = await create(owner, { password: "secret", maxDownloads: 2 });
    expect((await db.db.execute(`select sftpgo_share_id from app.shares`)).rows[0]).toEqual({
      sftpgo_share_id: null,
    });
    const path = pub(share.id);
    expect(await metadata(share.id)).toMatchObject({ name: "", hasPassword: true });
    expect(
      (await call(`${path}/credentials`, { method: "POST", body: { password: "nope" } })).status,
    ).toBe(401);
    const visitor = cookieFrom(
      await call(`${path}/credentials`, { method: "POST", body: { password: "secret" } }),
    );
    expect(await metadata(share.id, visitor)).toMatchObject({
      name: "Document",
      layout: "single-file",
      fileName: "doc.txt",
      credentialPresent: true,
      usedDownloads: 0,
    });
    const head = await call(`${path}/download`, { method: "HEAD", cookie: visitor });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("16");
    expect((await metadata(share.id, visitor)).usedDownloads).toBe(0);
    const tail = await call(`${path}/download`, {
      cookie: visitor,
      headers: { range: "bytes=-7" },
    });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe("bytes 9-15/16");
    expect(await tail.text()).toBe("content");
    const beyond = await call(`${path}/download`, {
      cookie: visitor,
      headers: { range: "bytes=99-" },
    });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */16");
    const full = await call(`${path}/download`, { cookie: visitor });
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("original content");
    expect((await metadata(share.id, visitor)).unavailableReason).toBe("limit");
    expect((await call(`${path}/download`, { cookie: visitor })).status).toBe(403);
  });

  it("lists and serves a directory share and stores uploads for an upload share", async () => {
    const owner = await login();
    const folder = await create(owner, { name: "Folder", paths: ["/folder"] });
    expect(
      ShareEntriesResponse.parse(await (await call(`${pub(folder.id)}/entries`)).json()).items.map(
        (entry) => entry.name,
      ),
    ).toEqual(["a.txt"]);
    expect(await (await call(`${pub(folder.id)}/download?path=/a.txt`)).text()).toBe(
      "child content",
    );
    expect((await call(`${pub(folder.id)}/download?path=/missing.txt`)).status).toBe(404);
    const inbox = await create(owner, { name: "Inbox", paths: ["/folder"], scope: "write" });
    expect(
      (
        await call(`${pub(inbox.id)}/upload?path=/sent.txt`, {
          method: "PUT",
          raw: "from a visitor",
        })
      ).status,
    ).toBe(200);
    const stored = createS3StorageProvider({
      client: async () =>
        createS3Client({
          endpoint: minio.endpoint,
          region: "us-east-1",
          credential: minio.writer,
          fetch: globalThis.fetch,
        }),
      bucket: minio.bucket,
      prefix: "",
    });
    expect(await text((await stored.download("/folder/sent.txt")).body)).toBe("from a visitor");
    expect((await metadata(inbox.id)).usedDownloads).toBe(1);
  });

  it("reached only MinIO, through the owner's key, and never an SFTPGo endpoint", () => {
    const hosts = new Set(upstream.map((request) => request.host));
    expect(hosts).toEqual(new Set([new URL(minio.endpoint).host]));
    expect(upstream.some((request) => request.path.startsWith("/api/v2/"))).toBe(false);
    expect(upstream.length).toBeGreaterThan(5);
  });
});
