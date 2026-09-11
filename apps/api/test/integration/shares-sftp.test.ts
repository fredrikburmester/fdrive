import { ManagedShare, MeResponse, PublicShare, SharesResponse } from "@fdrive/contracts";
import { createDb, createShareRepo } from "@fdrive/db";
import { createSftpgoClient } from "@fdrive/sftpgo";
import { startPostgres, startSftpgo } from "@fdrive/testkit";
import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { composeApp } from "../../src/composition.ts";
import { loadConfig } from "../../src/config.ts";

const base = "/api/v1/shares";
const pub = (id: string) => `/api/v1/public/shares/${id}`;
const cookieFrom = (r: Response) => r.headers.get("set-cookie")?.split(";")[0] ?? "";
describe("public share proxy against real SFTPGo and PostgreSQL", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let sftp: Awaited<ReturnType<typeof startSftpgo>>;
  let app: Awaited<ReturnType<typeof composeApp>>;
  let db: ReturnType<typeof createDb>;
  const requests: { path: string; authorization: string | null }[] = [];
  beforeAll(async () => {
    [postgres, sftp] = await Promise.all([
      startPostgres(),
      startSftpgo({
        users: ["alice", "bob"].map((username) => ({
          username,
          password: `${username}-pass`,
          permissions: { "/": ["*"] },
        })),
        folders: [],
        files: {
          alice: { "/doc.txt": "original content", "/folder/a.txt": "child content" },
          bob: { "/private.txt": "bob" },
        },
      }),
    ]);
    db = createDb(postgres.connectionString);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    app = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        SFTPGO_URL: sftp.baseUrl,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
      }),
      logger,
      () => new Date(),
      {
        fetch: async (input, init) => {
          const req = new Request(input, init);
          requests.push({
            path: new URL(req.url).pathname,
            authorization: req.headers.get("authorization"),
          });
          return fetch(req);
        },
      },
    );
  }, 180000);
  afterAll(async () => {
    await app?.close();
    await db?.close();
    await sftp?.stop();
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
        ...options.headers,
      },
      ...(options.body === undefined
        ? options.raw === undefined
          ? {}
          : { body: options.raw }
        : { body: JSON.stringify(options.body) }),
    });
  }
  async function login(username: string) {
    const res = await call("/api/v1/auth/login", {
      method: "POST",
      body: { credential: { username, password: `${username}-pass` } },
    });
    expect(res.status).toBe(200);
    MeResponse.parse(await res.json());
    return cookieFrom(res);
  }
  async function create(cookie: string, patch: Record<string, unknown> = {}) {
    const res = await call(base, {
      cookie,
      method: "POST",
      body: { name: "Doc", paths: ["/doc.txt"], scope: "read", ...patch },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ManagedShare.parse(await res.json());
  }
  async function credentials(id: string, password: string) {
    const res = await call(`${pub(id)}/credentials`, { method: "POST", body: { password } });
    expect(res.status).toBe(200);
    return cookieFrom(res);
  }
  it("scopes ownership, streams suffix ranges using public Basic auth, preserves/clears/sets passwords", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    const share = await create(alice, { password: "initial-secret" });
    expect(share.presentation).toBe("auto");
    const path = `${base}/${share.id}`;
    expect((await call(path, { cookie: bob })).status).toBe(404);
    expect((await call(path)).status).toBe(401);
    expect(
      (await call(path, { cookie: alice, headers: { authorization: "Bearer invalid" } })).status,
    ).toBe(403);
    // The listing serves each row from one upstream `shares.list` call, so
    // confirm real SFTPGo redacts the password on that endpoint exactly as it
    // does on the single-share read: a protected share must not list as open.
    expect(
      SharesResponse.parse(await (await call(base, { cookie: alice })).json()).items.find(
        (item) => item.id === share.id,
      ),
    ).toMatchObject({ id: share.id, hasPassword: true });
    // The link alone (or a wrong password) reveals nothing; the real SFTPGo
    // root listing verifies the correct one and unlocks the details.
    const withheld = { name: "", fileName: null, hasPassword: true, credentialPresent: false };
    expect(PublicShare.parse(await (await call(pub(share.id))).json())).toMatchObject(withheld);
    expect((await call(`${pub(share.id)}/download`)).status).toBe(401);
    const wrong = await credentials(share.id, "wrong");
    expect(
      PublicShare.parse(await (await call(pub(share.id), { cookie: wrong })).json()),
    ).toMatchObject(withheld);
    expect((await call(`${pub(share.id)}/download`, { cookie: wrong })).status).toBe(401);
    const cookie = await credentials(share.id, "initial-secret");
    expect(PublicShare.parse(await (await call(pub(share.id), { cookie })).json())).toMatchObject({
      layout: "single-file",
      presentation: "auto",
      fileName: "doc.txt",
      hasPassword: true,
      credentialPresent: true,
    });
    requests.length = 0;
    let res = await call(`${pub(share.id)}/download`, { cookie, headers: { range: "bytes=-7" } });
    expect(res.status, await res.clone().text()).toBe(206);
    expect(await res.text()).toBe("content");
    expect(res.headers.get("content-range")).toBe("bytes 9-15/16");
    expect(
      requests.some(
        (r) => r.path.includes("/api/v2/shares/") && r.authorization?.startsWith("Basic "),
      ),
    ).toBe(true);
    expect(
      requests
        .filter((r) => r.path.includes("/user/"))
        .every((r) => r.path.includes("/user/shares/")),
    ).toBe(true);
    res = await call(path, {
      cookie: alice,
      method: "PATCH",
      body: { name: "Renamed", presentation: "gallery" },
    });
    expect(res.status).toBe(200);
    const renamed = ManagedShare.parse(await res.json());
    expect(renamed.hasPassword).toBe(true);
    expect(renamed.presentation).toBe("gallery");
    res = await call(path, { cookie: alice, method: "PATCH", body: { name: "Renamed again" } });
    expect(ManagedShare.parse(await res.json()).presentation).toBe("gallery");
    res = await call(`${pub(share.id)}/download`, { cookie });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    res = await call(path, { cookie: alice, method: "PATCH", body: { password: "" } });
    expect(ManagedShare.parse(await res.json()).hasPassword).toBe(false);
    res = await call(`${pub(share.id)}/download`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await call(path, { cookie: alice, method: "PATCH", body: { password: "replacement" } });
    expect((await call(`${pub(share.id)}/download`, { cookie })).status).toBe(401);
    const updated = await credentials(share.id, "replacement");
    res = await call(`${pub(share.id)}/download`, { cookie: updated });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect((await call(path, { cookie: alice, method: "DELETE" })).status).toBe(200);
    expect((await call(pub(share.id))).status).toBe(404);
  });
  it("lists without consuming quota, downloads directory children/ZIP, enforces write-only upload and traversal", async () => {
    const alice = await login("alice");
    const dir = await create(alice, { paths: ["/folder"], maxDownloads: 3 });
    let res = await call(`${pub(dir.id)}/entries`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ name: "a.txt" }] });
    expect(PublicShare.parse(await (await call(pub(dir.id))).json()).usedDownloads).toBe(0);
    res = await call(`${pub(dir.id)}/download?path=/a.txt`);
    expect(await res.text()).toBe("child content");
    res = await call(`${pub(dir.id)}/archive`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const upload = await create(alice, {
      scope: "write",
      paths: ["/folder"],
      password: "upload-secret",
    });
    const cookie = await credentials(upload.id, "upload-secret");
    for (const action of ["entries", "download", "archive"])
      expect((await call(`${pub(upload.id)}/${action}`, { cookie })).status).toBe(403);
    expect(
      (
        await call(`${pub(upload.id)}/upload?path=/new.txt`, {
          cookie,
          method: "PUT",
          raw: "uploaded",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`${pub(upload.id)}/upload?path=/%252e%252e/x`, {
          cookie,
          method: "PUT",
          raw: "bad",
        })
      ).status,
    ).toBe(400);
    const client = createSftpgoClient({ baseUrl: sftp.baseUrl });
    const user = client.user(
      (await client.login({ username: "alice", password: "alice-pass" })).accessToken,
    );
    expect(await new Response((await user.download("/folder/new.txt")).body).text()).toBe(
      "uploaded",
    );
    for (const path of ["/../doc.txt", "/folder/../doc.txt"])
      expect((await call(`${pub(dir.id)}/download?path=${encodeURIComponent(path)}`)).status).toBe(
        400,
      );
  });
  it("enforces exhaustion, expiry, upstream revocation and multi-path restrictions", async () => {
    const alice = await login("alice");
    const share = await create(alice, { maxDownloads: 1 });
    let res = await call(`${pub(share.id)}/download`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect((await call(`${pub(share.id)}/download`)).status).toBe(403);
    expect(PublicShare.parse(await (await call(pub(share.id))).json()).unavailableReason).toBe(
      "limit",
    );
    const expires = await create(alice, { expiresAt: new Date(Date.now() + 1500).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(PublicShare.parse(await (await call(pub(expires.id))).json()).unavailableReason).toBe(
      "expired",
    );
    expect((await call(`${pub(expires.id)}/download`)).status).toBe(403);
    const multi = await create(alice, { paths: ["/doc.txt", "/folder/a.txt"] });
    expect((await call(`${pub(multi.id)}/download`)).status).toBe(400);
    expect((await call(`${pub(multi.id)}/entries`)).status).toBe(400);
    res = await call(`${pub(multi.id)}/archive`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const revoked = await create(alice);
    const row = await createShareRepo(db.db).get(revoked.id);
    if (!row) throw new Error("missing share");
    const client = createSftpgoClient({ baseUrl: sftp.baseUrl });
    const user = client.user(
      (await client.login({ username: "alice", password: "alice-pass" })).accessToken,
    );
    await user.shares.remove(row.sftpgoShareId);
    expect((await call(pub(revoked.id))).status).toBe(404);
    expect(await createShareRepo(db.db).get(revoked.id)).toBeNull();
  });
  it("compensates a real database failure without leaving an upstream share", async () => {
    const alice = await login("alice");
    await db.pool.query(
      "CREATE FUNCTION app.reject_test_share() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'force-db-failure' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$",
    );
    await db.pool.query(
      "CREATE TRIGGER reject_test_share BEFORE INSERT ON app.shares FOR EACH ROW EXECUTE FUNCTION app.reject_test_share()",
    );
    try {
      const result = await call(base, {
        cookie: alice,
        method: "POST",
        body: { name: "force-db-failure", paths: ["/doc.txt"], scope: "read" },
      });
      expect(result.status).toBe(502);
      const client = createSftpgoClient({ baseUrl: sftp.baseUrl });
      const user = client.user(
        (await client.login({ username: "alice", password: "alice-pass" })).accessToken,
      );
      expect((await user.shares.list()).some((share) => share.name === "force-db-failure")).toBe(
        false,
      );
    } finally {
      await db.pool.query("DROP TRIGGER reject_test_share ON app.shares");
      await db.pool.query("DROP FUNCTION app.reject_test_share()");
    }
  });
  it("roundtrips Unicode, spaces and literal-percent names without interpreting them as traversal", async () => {
    const alice = await login("alice");
    const client = createSftpgoClient({ baseUrl: sftp.baseUrl });
    const user = client.user(
      (await client.login({ username: "alice", password: "alice-pass" })).accessToken,
    );
    const directory = await create(alice, { paths: ["/folder"] });
    const write = await create(alice, { paths: ["/folder"], scope: "write" });
    for (const name of ["literal%20.txt", "文 space.txt", "literal%2F.txt"]) {
      await user.upload(`/folder/${name}`, new TextEncoder().encode(name));
      const single = await create(alice, { paths: [`/folder/${name}`] });
      expect(single.paths).toEqual([`/folder/${name}`]);
      expect(await (await call(`${pub(single.id)}/download`)).text()).toBe(name);
      expect(
        await (
          await call(`${pub(directory.id)}/download?path=${encodeURIComponent(`/${name}`)}`)
        ).text(),
      ).toBe(name);
      const uploaded = await call(
        `${pub(write.id)}/upload?path=${encodeURIComponent(`/${name}`)}`,
        { method: "PUT", raw: `new ${name}` },
      );
      expect(uploaded.status).toBe(200);
      expect(await new Response((await user.download(`/folder/${name}`)).body).text()).toBe(
        `new ${name}`,
      );
    }
    for (const encoded of ["%2F..%2Fdoc.txt", "%2F%2e%2e%2Fdoc.txt", "%2Ffoo%5C..%5Cdoc.txt"])
      expect((await call(`${pub(directory.id)}/download?path=${encoded}`)).status).toBe(400);
  });
});
