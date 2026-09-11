import { isStorageError, StorageError } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { createWebdavClient } from "./client.js";
import { WebdavError } from "./errors.js";
import { createFakeWebdavServer } from "./fake/server.js";
import { createWebdavStorageProvider, toStorageError } from "./storage-provider.js";
import type { WebdavClient } from "./types.js";

const ALICE = { username: "alice", password: "secret" };
const BOB = { username: "bob", password: "pw", readOnly: true };

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

async function kindOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isStorageError(error) ? error.kind : `not a StorageError: ${String(error)}`;
  }
}

function setup(credential = ALICE) {
  const server = createFakeWebdavServer({
    users: [ALICE, BOB],
    files: { "/docs/a.txt": "hello", "/docs/sub/b.txt": "b" },
  });
  const client = createWebdavClient({ baseUrl: "http://webdav.test/", fetch: server.fetch });
  const storage = createWebdavStorageProvider({ client, credential: async () => credential });
  return { server, client, storage };
}

describe("toStorageError", () => {
  it.each([
    ["network", null, "upstream_unavailable"],
    ["server", 503, "upstream_unavailable"],
    ["server", 302, "upstream_unavailable"],
    ["unexpected", 418, "internal"],
    ["unauthorized", 401, "unauthorized"],
    ["forbidden", 403, "forbidden"],
    ["not_found", 404, "not_found"],
    ["conflict", 409, "conflict"],
    ["payload_too_large", 507, "payload_too_large"],
    ["rate_limited", 429, "rate_limited"],
    ["bad_request", 416, "bad_request"],
  ] as const)("maps kind %s (status %s) to %s", (kind, status, expected) => {
    try {
      toStorageError(new WebdavError("boom", kind, status, "why"));
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({
        kind: expected,
        message: "boom",
        details: status === null ? { detail: "why" } : { status, detail: "why" },
      });
      expect((error as StorageError).cause).toBeInstanceOf(WebdavError);
      return;
    }
    throw new Error("did not throw");
  });

  it("applies status overrides and omits empty details", () => {
    try {
      toStorageError(new WebdavError("x", "conflict", 409, null), { 409: "not_found" });
    } catch (error) {
      expect(error).toMatchObject({ kind: "not_found", details: { status: 409 } });
    }
    try {
      toStorageError(new WebdavError("x", "network", null, null));
    } catch (error) {
      expect((error as StorageError).details).toBeUndefined();
    }
  });

  it("rethrows anything that is not a WebdavError", () => {
    const plain = new Error("plain");
    expect(() => toStorageError(plain)).toThrow(plain);
  });
});

describe("createWebdavStorageProvider", () => {
  it("exposes own-property methods and omits unsupported optional ones", () => {
    const { storage } = setup();
    for (const method of [
      "list",
      "stat",
      "statFile",
      "probeDirectoryRead",
      "download",
      "upload",
      "mkdir",
      "move",
      "copy",
      "deleteFile",
      "deleteDir",
    ]) {
      expect(Object.hasOwn(storage, method)).toBe(true);
    }
    expect(storage.zip).toBeUndefined();
    expect(storage.setModifiedAt).toBeUndefined();
    expect(storage.trash).toBeUndefined();
  });

  it("asks for the credential on every call and rethrows a failing resolver unchanged", async () => {
    const { client } = setup();
    const credential = vi.fn(async () => ALICE);
    const storage = createWebdavStorageProvider({ client, credential });
    await storage.stat("/");
    await storage.list("/");
    expect(credential).toHaveBeenCalledTimes(2);
    const failing = createWebdavStorageProvider({
      client,
      credential: async () => {
        throw new Error("vault closed");
      },
    });
    await expect(failing.stat("/")).rejects.toThrow("vault closed");
  });

  it("lists with normalized paths and an epoch mtime when the server sends none", async () => {
    const { storage } = setup();
    const entries = await storage.list("docs/");
    expect(entries.map((entry) => entry.path).sort()).toEqual(["/docs/a.txt", "/docs/sub"]);
    expect(entries.find((entry) => entry.name === "a.txt")).toMatchObject({ ext: ".txt", size: 5 });
    const body = `<D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/d/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>/d/x</D:href><D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    </D:multistatus>`;
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 207 }),
    ) as unknown as typeof fetch;
    const client: WebdavClient = createWebdavClient({ baseUrl: "http://h/", fetch: fetchImpl });
    const bare = createWebdavStorageProvider({ client, credential: async () => ALICE });
    expect((await bare.list("/d"))[0]?.modifiedAt.getTime()).toBe(0);
  });

  it("stats and refuses the wrong kind in statFile, deleteFile and deleteDir", async () => {
    const { storage } = setup();
    expect(await storage.stat("/docs")).toEqual({
      kind: "dir",
      size: 0,
      modifiedAt: expect.any(Date),
      contentType: null,
    });
    expect(await storage.statFile("/docs/a.txt")).toMatchObject({
      size: 5,
      contentType: "text/plain",
    });
    expect(await kindOf(storage.statFile("/docs"))).toBe("bad_request");
    expect(await kindOf(storage.deleteFile("/docs"))).toBe("bad_request");
    expect(await kindOf(storage.deleteDir("/docs/a.txt"))).toBe("bad_request");
    expect(await kindOf(storage.deleteFile("/nope"))).toBe("not_found");
    expect(await kindOf(storage.deleteDir("/nope"))).toBe("not_found");
    expect(await storage.stat("/docs/a.txt")).toMatchObject({ kind: "file" });
    await storage.deleteFile("/docs/a.txt");
    expect(await kindOf(storage.stat("/docs/a.txt"))).toBe("not_found");
    await storage.deleteDir("/docs");
    expect(await kindOf(storage.stat("/docs/sub/b.txt"))).toBe("not_found");
  });

  it("probes directories and maps the failures", async () => {
    const { storage } = setup();
    const probe = storage.probeDirectoryRead;
    if (probe === undefined) throw new Error("probeDirectoryRead should be present");
    await expect(probe("/docs")).resolves.toBeUndefined();
    expect(await kindOf(probe("/docs/a.txt"))).toBe("bad_request");
    expect(await kindOf(probe("/nope"))).toBe("not_found");
  });

  it("downloads with a stale If-Range falling back to the whole body", async () => {
    const { storage } = setup();
    const stale = await storage.download("/docs/a.txt", {
      range: { start: 0, end: 0 },
      ifRange: '"stale"',
    });
    expect(stale.status).toBe(200);
    expect(await text(stale.body)).toBe("hello");
    const fresh = await storage.download("/docs/a.txt", { range: { start: 1, end: 2 } });
    expect(fresh.status).toBe(206);
    expect(await text(fresh.body)).toBe("el");
  });

  it("uploads: parents on request, overwrite refusal, missing parent and cancellation", async () => {
    const { server, storage } = setup();
    await storage.upload("/new/deep/f.txt", bytes("x"), { mkdirParents: true, contentLength: 1 });
    expect(await text((await storage.download("/new/deep/f.txt")).body)).toBe("x");
    expect(await kindOf(storage.upload("/nope/f.txt", bytes("x")))).toBe("conflict");
    expect(await kindOf(storage.upload("/new/deep/f.txt", bytes("y"), { overwrite: false }))).toBe(
      "conflict",
    );
    await storage.upload("/new/deep/f.txt", bytes("y"), { overwrite: true });
    expect(await text((await storage.download("/new/deep/f.txt")).body)).toBe("y");
    const at = new Date("2021-01-01T00:00:00Z");
    await storage.upload("/stamped.txt", bytes("s"), { modifiedAt: at });
    expect(server.requests.at(-1)?.headers["x-oc-mtime"]).toBe("1609459200");
    const controller = new AbortController();
    controller.abort();
    expect(await kindOf(storage.upload("/c.txt", bytes("c"), { signal: controller.signal }))).toBe(
      "upstream_unavailable",
    );
    expect(await kindOf(storage.upload("/docs/a.txt/x", bytes("x"), { mkdirParents: true }))).toBe(
      "conflict",
    );
  });

  it("mkdir: conflict on existing, not_found on a missing parent, parents on request", async () => {
    const { storage } = setup();
    await storage.mkdir("/one");
    expect(await storage.stat("/one")).toMatchObject({ kind: "dir" });
    expect(await kindOf(storage.mkdir("/one"))).toBe("conflict");
    expect(await kindOf(storage.mkdir("/docs/a.txt"))).toBe("conflict");
    expect(await kindOf(storage.mkdir("/nope/two"))).toBe("not_found");
    await storage.mkdir("/a/b/c", { parents: true });
    expect(await storage.stat("/a/b/c")).toMatchObject({ kind: "dir" });
    await expect(storage.mkdir("/a/b", { parents: true })).resolves.toBeUndefined();
    await expect(storage.mkdir("/", { parents: true })).resolves.toBeUndefined();
    expect(await kindOf(storage.mkdir("/docs/a.txt", { parents: true }))).toBe("conflict");
    expect(await kindOf(storage.mkdir("/docs/a.txt/child", { parents: true }))).toBe("conflict");
  });

  it("mkdir with parents rethrows failures that are not conflicts", async () => {
    const { storage } = setup(BOB);
    expect(await kindOf(storage.mkdir("/x/y", { parents: true }))).toBe("forbidden");
    // MKCOL says the path exists, but the follow-up stat fails for another reason.
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === "MKCOL"
        ? new Response(null, { status: 405 })
        : new Response("down", { status: 503 }),
    ) as unknown as typeof fetch;
    const flaky = createWebdavStorageProvider({
      client: createWebdavClient({ baseUrl: "http://h/", fetch: fetchImpl }),
      credential: async () => ALICE,
    });
    expect(await kindOf(flaky.mkdir("/x", { parents: true }))).toBe("upstream_unavailable");
  });

  it("move and copy: overwrite by default, refuse when asked, missing parents are not_found", async () => {
    const { storage } = setup();
    await storage.move("/docs/a.txt", "/docs/renamed.txt");
    expect(await kindOf(storage.stat("/docs/a.txt"))).toBe("not_found");
    await storage.copy("/docs/renamed.txt", "/docs/sub/b.txt");
    expect(await text((await storage.download("/docs/sub/b.txt")).body)).toBe("hello");
    expect(
      await kindOf(storage.move("/docs/renamed.txt", "/docs/sub/b.txt", { overwrite: false })),
    ).toBe("conflict");
    expect(await kindOf(storage.copy("/docs/renamed.txt", "/nope/x.txt"))).toBe("not_found");
    expect(await kindOf(storage.move("/docs/renamed.txt", "/nope/x.txt"))).toBe("not_found");
    expect(await kindOf(storage.move("/missing", "/x"))).toBe("not_found");
    await storage.move("/docs", "/moved");
    expect(await text((await storage.download("/moved/sub/b.txt")).body)).toBe("hello");
  });

  it("reports a refused move of a missing source as not_found, and of an existing one as forbidden", async () => {
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === "MOVE" || init?.method === "COPY") {
        return new Response("Forbidden", { status: 403 });
      }
      return String(url).includes("/present")
        ? new Response(
            `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/present</D:href><D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
            { status: 207 },
          )
        : new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const storage = createWebdavStorageProvider({
      client: createWebdavClient({ baseUrl: "http://h/", fetch: fetchImpl }),
      credential: async () => ALICE,
    });
    expect(await kindOf(storage.move("/missing", "/x"))).toBe("not_found");
    expect(await kindOf(storage.copy("/missing", "/x"))).toBe("not_found");
    expect(await kindOf(storage.move("/present", "/x"))).toBe("forbidden");
    expect(await kindOf(storage.copy("/present", "/x"))).toBe("forbidden");
  });

  it("maps denied writes to forbidden and a wrong password to unauthorized", async () => {
    const { storage: bob } = setup(BOB);
    expect(await kindOf(bob.upload("/x.txt", bytes("x")))).toBe("forbidden");
    expect(await kindOf(bob.deleteFile("/docs/a.txt"))).toBe("forbidden");
    expect(await kindOf(bob.move("/docs/a.txt", "/y"))).toBe("forbidden");
    expect(await text((await bob.download("/docs/a.txt")).body)).toBe("hello");
    const { storage: wrong } = setup({ username: "alice", password: "nope" });
    expect(await kindOf(wrong.list("/"))).toBe("unauthorized");
  });

  it("reports an unreachable or redirecting server as upstream_unavailable", async () => {
    const down = createWebdavClient({
      baseUrl: "http://elsewhere.test/",
      fetch: createFakeWebdavServer({ users: [ALICE] }).fetch,
    });
    const storage = createWebdavStorageProvider({ client: down, credential: async () => ALICE });
    expect(await kindOf(storage.list("/"))).toBe("upstream_unavailable");
    const redirecting = createWebdavClient({
      baseUrl: "http://webdav.test/",
      fetch: createFakeWebdavServer({ users: [ALICE], redirectTo: "http://evil.test/" }).fetch,
    });
    const bounced = createWebdavStorageProvider({
      client: redirecting,
      credential: async () => ALICE,
    });
    expect(await kindOf(bounced.download("/x"))).toBe("upstream_unavailable");
  });
});
