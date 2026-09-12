import { describe, expect, it, vi } from "vitest";
import { createWebdavClient } from "./client.js";
import { WebdavError } from "./errors.js";
import { createFakeWebdavServer, type FakeWebdavOptions } from "./fake/server.js";
import type { WebdavUserApi } from "./types.js";

const ALICE = { username: "alice", password: "secret" };
const BOB = { username: "bob", password: "pw", readOnly: true };

function text(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function stream(value: string): ReadableStream<Uint8Array> {
  return new Response(value).body ?? new ReadableStream();
}

async function kindOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof WebdavError ? error.kind : `not a WebdavError: ${String(error)}`;
  }
}

function setup(options: Partial<FakeWebdavOptions> = {}, baseUrl = "http://webdav.test/") {
  const server = createFakeWebdavServer({
    users: [ALICE, BOB],
    files: { "/docs/a.txt": "hello", "/docs/sub/b.txt": "b", "/root.txt": "r" },
    ...options,
  });
  const client = createWebdavClient({ baseUrl, fetch: server.fetch });
  return { server, client, alice: client.user(ALICE), bob: client.user(BOB) };
}

function lastRequest(server: ReturnType<typeof createFakeWebdavServer>) {
  const request = server.requests.at(-1);
  if (request === undefined) throw new Error("no request recorded");
  return request;
}

describe("createWebdavClient", () => {
  it("exposes the endpoint it was built for and defaults fetch to the global", () => {
    const client = createWebdavClient({ baseUrl: "http://h/dav" });
    expect(client.baseUrl).toBe("http://h/dav");
  });

  it("sends Basic credentials, a User-Agent and identity encoding on every request", async () => {
    const { server, alice } = setup();
    await alice.stat("/");
    expect(lastRequest(server).headers).toMatchObject({
      authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
      "user-agent": "fdrive",
      "accept-encoding": "identity",
      depth: "0",
    });
    const custom = createWebdavClient({
      baseUrl: "http://webdav.test/",
      fetch: server.fetch,
      userAgent: "probe/1",
    });
    await custom.user(ALICE).stat("/");
    expect(lastRequest(server).headers["user-agent"]).toBe("probe/1");
  });

  it("rejects wrong credentials as unauthorized", async () => {
    const { client } = setup();
    expect(await kindOf(client.user({ username: "alice", password: "no" }).stat("/"))).toBe(
      "unauthorized",
    );
  });
});

describe("list", () => {
  it("returns the members of a collection with kind, size, type and etag", async () => {
    const { alice } = setup();
    const entries = await alice.list("/docs");
    expect(entries.map((entry) => entry.name).sort()).toEqual(["a.txt", "sub"]);
    expect(entries.find((entry) => entry.name === "a.txt")).toMatchObject({
      path: "/docs/a.txt",
      kind: "file",
      size: 5,
      contentType: "text/plain",
    });
    expect(entries.find((entry) => entry.name === "a.txt")?.etag).toMatch(/^"5-\d+"$/);
    expect(entries.find((entry) => entry.name === "sub")).toMatchObject({
      path: "/docs/sub",
      kind: "dir",
      size: 0,
      contentType: null,
    });
    expect(entries[0]?.modifiedAt).toBeInstanceOf(Date);
  });

  it("lists the root and an empty collection", async () => {
    const { alice } = setup();
    expect((await alice.list("/")).map((entry) => entry.name).sort()).toEqual(["docs", "root.txt"]);
    await alice.mkcol("/empty");
    expect(await alice.list("/empty")).toEqual([]);
  });

  it("sends Depth 1 to the collection URL with a trailing slash", async () => {
    const { server, alice } = setup({ prefix: "/dav" }, "http://webdav.test/dav");
    await alice.list("/docs");
    expect(lastRequest(server)).toMatchObject({
      method: "PROPFIND",
      url: "http://webdav.test/dav/docs/",
      headers: { depth: "1" },
    });
  });

  it.each([
    ["absolute hrefs", { hrefStyle: "absolute" }],
    ["a default namespace", { namespaceStyle: "default" }],
    ["absolute hrefs under a prefix", { hrefStyle: "absolute", prefix: "/dav/x" }],
  ] as const)("reads a server answering with %s", async (_, options) => {
    const prefix = "prefix" in options ? options.prefix : "";
    const { alice } = setup({ ...options }, `http://webdav.test${prefix}`);
    expect((await alice.list("/docs")).map((entry) => entry.path).sort()).toEqual([
      "/docs/a.txt",
      "/docs/sub",
    ]);
  });

  it("keeps Unicode and literal-percent names intact", async () => {
    const name = "ünï cødé %41 😀.txt";
    const { alice } = setup();
    await alice.upload(`/${name}`, bytes("u"));
    expect((await alice.list("/")).map((entry) => entry.name)).toContain(name);
    expect(await text((await alice.download(`/${name}`)).body)).toBe("u");
  });

  it("reports a file as bad_request and a missing path as not_found", async () => {
    const { alice } = setup();
    expect(await kindOf(alice.list("/docs/a.txt"))).toBe("bad_request");
    expect(await kindOf(alice.list("/missing"))).toBe("not_found");
    expect(await kindOf(alice.list("relative"))).toBe("bad_request");
  });

  it("ignores hrefs on another origin or outside the endpoint and members with an error status", async () => {
    const body = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/dav/d/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>http://evil.test/dav/d/x</D:href><D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>/other/d/y</D:href><D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>/dav/d/deep/z</D:href><D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>/dav/d/gone</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>
      <D:response><D:href>/dav/d/ok</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>3</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>/dav/d/nolength</D:href><D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    </D:multistatus>`;
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 207 }),
    ) as unknown as typeof fetch;
    const api = createWebdavClient({ baseUrl: "http://host/dav", fetch: fetchImpl }).user(ALICE);
    expect(await api.list("/d")).toEqual([
      {
        name: "ok",
        path: "/d/ok",
        kind: "file",
        size: 3,
        modifiedAt: null,
        contentType: null,
        etag: null,
      },
      {
        name: "nolength",
        path: "/d/nolength",
        kind: "file",
        size: 0,
        modifiedAt: null,
        contentType: null,
        etag: null,
      },
    ]);
  });

  it("fails clearly when the answer does not describe the requested path", async () => {
    const body = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/elsewhere</D:href></D:response></D:multistatus>`;
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 207 }),
    ) as unknown as typeof fetch;
    const api = createWebdavClient({ baseUrl: "http://host/", fetch: fetchImpl }).user(ALICE);
    await expect(api.list("/d")).rejects.toMatchObject({
      kind: "unexpected",
      detail: "no response matched the request href",
    });
  });

  it("refuses a 200 without multistatus, an oversized body and too many entries", async () => {
    const ok = vi.fn(
      async () => new Response("<html/>", { status: 200 }),
    ) as unknown as typeof fetch;
    expect(
      await kindOf(createWebdavClient({ baseUrl: "http://h/", fetch: ok }).user(ALICE).list("/")),
    ).toBe("unexpected");
    const { server } = setup();
    const small = createWebdavClient({
      baseUrl: "http://webdav.test/",
      fetch: server.fetch,
      maxMultistatusBytes: 100,
    });
    await expect(small.user(ALICE).list("/")).rejects.toMatchObject({
      kind: "unexpected",
      detail: "body exceeds 100 bytes or was cut short",
    });
    const few = createWebdavClient({
      baseUrl: "http://webdav.test/",
      fetch: server.fetch,
      maxMultistatusEntries: 1,
    });
    await expect(few.user(ALICE).list("/")).rejects.toMatchObject({ kind: "unexpected" });
  });
});

describe("stat and probeDirectoryRead", () => {
  it("stats files, directories and the root", async () => {
    const { alice } = setup();
    expect(await alice.stat("/docs/a.txt")).toMatchObject({
      kind: "file",
      size: 5,
      contentType: "text/plain",
    });
    expect(await alice.stat("/docs")).toMatchObject({ kind: "dir", size: 0, contentType: null });
    expect(await alice.stat("/")).toMatchObject({ kind: "dir" });
    expect(await kindOf(alice.stat("/nope"))).toBe("not_found");
  });

  it("treats a 207 whose own response is a 404 as not_found", async () => {
    const body = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/x</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response></D:multistatus>`;
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 207 }),
    ) as unknown as typeof fetch;
    const api = createWebdavClient({ baseUrl: "http://h/", fetch: fetchImpl }).user(ALICE);
    expect(await kindOf(api.stat("/x"))).toBe("not_found");
  });

  it("probes a directory with a live Depth 1 read and refuses files and missing paths", async () => {
    const { server, alice } = setup();
    await expect(alice.probeDirectoryRead("/docs")).resolves.toBeUndefined();
    expect(lastRequest(server)).toMatchObject({ method: "PROPFIND", headers: { depth: "1" } });
    expect(await kindOf(alice.probeDirectoryRead("/docs/a.txt"))).toBe("bad_request");
    expect(await kindOf(alice.probeDirectoryRead("/nope"))).toBe("not_found");
    expect(await kindOf(alice.probeDirectoryRead("bad"))).toBe("bad_request");
  });

  it("probe fails when the listing itself is refused", async () => {
    let calls = 0;
    const { server } = setup();
    const flaky = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls += 1;
      if (calls === 2) return new Response(null, { status: 403 });
      return server.fetch(input, init);
    }) as typeof fetch;
    const api = createWebdavClient({ baseUrl: "http://webdav.test/", fetch: flaky }).user(ALICE);
    expect(await kindOf(api.probeDirectoryRead("/docs"))).toBe("forbidden");
  });
});

describe("download", () => {
  it("streams whole files with metadata", async () => {
    const { alice } = setup();
    const result = await alice.download("/docs/a.txt");
    expect(result.status).toBe(200);
    expect(result.contentLength).toBe(5);
    expect(result.contentRange).toBeNull();
    expect(result.contentType).toBe("text/plain");
    expect(result.lastModified).toBeInstanceOf(Date);
    expect(await text(result.body)).toBe("hello");
  });

  it("honours ranges, open ranges and If-Range", async () => {
    const { server, alice } = setup();
    const range = await alice.download("/docs/a.txt", { range: { start: 1, end: 3 } });
    expect(range.status).toBe(206);
    expect(range.contentRange).toBe("bytes 1-3/5");
    expect(await text(range.body)).toBe("ell");
    expect(lastRequest(server).headers.range).toBe("bytes=1-3");
    const open = await alice.download("/docs/a.txt", { range: { start: 3 } });
    expect(await text(open.body)).toBe("lo");
    expect(lastRequest(server).headers.range).toBe("bytes=3-");
    const stat = await alice.stat("/docs/a.txt");
    const matching = await alice.download("/docs/a.txt", {
      range: { start: 0, end: 0 },
      ifRange: stat.etag ?? "",
    });
    expect(matching.status).toBe(206);
    const stale = await alice.download("/docs/a.txt", {
      range: { start: 0, end: 0 },
      ifRange: '"stale"',
    });
    expect(stale.status).toBe(200);
    expect(await text(stale.body)).toBe("hello");
  });

  it("maps 416, 404 and an already-aborted signal", async () => {
    const { alice } = setup();
    expect(await kindOf(alice.download("/docs/a.txt", { range: { start: 99 } }))).toBe(
      "bad_request",
    );
    expect(await kindOf(alice.download("/nope"))).toBe("not_found");
    const controller = new AbortController();
    controller.abort();
    expect(await kindOf(alice.download("/docs/a.txt", { signal: controller.signal }))).toBe(
      "network",
    );
  });

  it("drops the declared length of a body the server encoded anyway", async () => {
    const encoded = vi.fn(
      async () =>
        new Response("", {
          status: 200,
          headers: { "Content-Encoding": "gzip", "Content-Length": "23" },
        }),
    ) as unknown as typeof fetch;
    const gz = createWebdavClient({ baseUrl: "http://h/", fetch: encoded }).user(ALICE);
    expect((await gz.download("/empty.txt")).contentLength).toBeNull();
    const identity = vi.fn(
      async () =>
        new Response("hello", {
          status: 200,
          headers: { "Content-Encoding": "identity", "Content-Length": "5" },
        }),
    ) as unknown as typeof fetch;
    const plain = createWebdavClient({ baseUrl: "http://h/", fetch: identity }).user(ALICE);
    expect((await plain.download("/a.txt")).contentLength).toBe(5);
  });

  it("substitutes an empty stream for a bodiless 200", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const api = createWebdavClient({ baseUrl: "http://h/", fetch: fetchImpl }).user(ALICE);
    expect(await text((await api.download("/x")).body)).toBe("");
  });
});

describe("upload", () => {
  it("creates and overwrites files from bytes and streams", async () => {
    const { server, alice } = setup();
    await alice.upload("/new.txt", bytes("one"), { contentLength: 3 });
    expect(lastRequest(server)).toMatchObject({
      method: "PUT",
      headers: { "content-length": "3", "content-type": "application/octet-stream" },
    });
    expect(await text((await alice.download("/new.txt")).body)).toBe("one");
    await alice.upload("/new.txt", stream("two"));
    expect(await text((await alice.download("/new.txt")).body)).toBe("two");
  });

  it("sends X-OC-Mtime and If-None-Match as asked", async () => {
    const { server, alice } = setup();
    const at = new Date("2020-01-02T03:04:05.678Z");
    await alice.upload("/m.txt", bytes("m"), { modifiedAt: at });
    expect(lastRequest(server).headers["x-oc-mtime"]).toBe("1577934245");
    expect((await alice.stat("/m.txt")).modifiedAt?.getTime()).toBe(1577934245000);
    expect(await kindOf(alice.upload("/m.txt", bytes("x"), { overwrite: false }))).toBe("conflict");
    expect(lastRequest(server).headers["if-none-match"]).toBe("*");
    await expect(
      alice.upload("/fresh.txt", bytes("x"), { overwrite: false }),
    ).resolves.toBeUndefined();
  });

  it("maps a missing parent, a directory target, denied writes and aborts", async () => {
    const { alice, bob } = setup();
    expect(await kindOf(alice.upload("/nope/x.txt", bytes("x")))).toBe("conflict");
    expect(await kindOf(alice.upload("/docs", bytes("x")))).toBe("conflict");
    expect(await kindOf(bob.upload("/x.txt", bytes("x")))).toBe("forbidden");
    const controller = new AbortController();
    controller.abort();
    expect(await kindOf(alice.upload("/x.txt", bytes("x"), { signal: controller.signal }))).toBe(
      "network",
    );
  });
});

describe("mkcol, move, copy and delete", () => {
  it("creates collections and reports existing or orphaned ones", async () => {
    const { server, alice } = setup();
    await alice.mkcol("/made");
    expect(lastRequest(server)).toMatchObject({ method: "MKCOL", url: "http://webdav.test/made/" });
    expect(await alice.stat("/made")).toMatchObject({ kind: "dir" });
    expect(await kindOf(alice.mkcol("/made"))).toBe("conflict");
    expect(await kindOf(alice.mkcol("/nope/deep"))).toBe("conflict");
    expect(await kindOf(alice.mkcol("bad"))).toBe("bad_request");
  });

  it("moves files and whole collections with Destination and Overwrite headers", async () => {
    const { server, alice } = setup({ prefix: "/dav" }, "http://webdav.test/dav/");
    await alice.move("/docs/a.txt", "/docs/renamed.txt");
    expect(lastRequest(server)).toMatchObject({
      method: "MOVE",
      url: "http://webdav.test/dav/docs/a.txt",
      headers: { destination: "http://webdav.test/dav/docs/renamed.txt", overwrite: "T" },
    });
    expect(await kindOf(alice.stat("/docs/a.txt"))).toBe("not_found");
    await alice.move("/docs", "/moved");
    expect(await text((await alice.download("/moved/sub/b.txt")).body)).toBe("b");
    expect(await kindOf(alice.stat("/docs"))).toBe("not_found");
  });

  it("overwrites by default and conflicts when asked not to", async () => {
    const { server, alice } = setup();
    await alice.upload("/old.txt", bytes("old"));
    expect(await kindOf(alice.move("/root.txt", "/old.txt", { overwrite: false }))).toBe(
      "conflict",
    );
    expect(lastRequest(server).headers.overwrite).toBe("F");
    await alice.copy("/root.txt", "/old.txt");
    expect(await text((await alice.download("/old.txt")).body)).toBe("r");
    expect(await text((await alice.download("/root.txt")).body)).toBe("r");
  });

  it("copies collections recursively with Depth infinity", async () => {
    const { server, alice } = setup();
    await alice.copy("/docs", "/docs2");
    expect(lastRequest(server).headers.depth).toBe("infinity");
    expect(await text((await alice.download("/docs2/sub/b.txt")).body)).toBe("b");
    expect(await text((await alice.download("/docs/sub/b.txt")).body)).toBe("b");
  });

  it("maps missing sources and targets, and validates both paths", async () => {
    const { alice } = setup();
    expect(await kindOf(alice.move("/nope", "/x"))).toBe("not_found");
    expect(await kindOf(alice.copy("/root.txt", "/nope/x"))).toBe("conflict");
    expect(await kindOf(alice.move("bad", "/x"))).toBe("bad_request");
    expect(await kindOf(alice.move("/root.txt", "bad"))).toBe("bad_request");
  });

  it("deletes files and collections, reporting a missing path", async () => {
    const { server, alice } = setup();
    await alice.delete("/root.txt");
    expect(lastRequest(server).method).toBe("DELETE");
    expect(await kindOf(alice.delete("/root.txt"))).toBe("not_found");
    await alice.delete("/docs");
    expect(await kindOf(alice.stat("/docs/sub/b.txt"))).toBe("not_found");
    expect(await kindOf(alice.delete("bad"))).toBe("bad_request");
  });

  it("never follows a redirect", async () => {
    const { alice } = setup({ redirectTo: "http://evil.test/" });
    for (const call of [
      alice.stat("/"),
      alice.download("/root.txt"),
      alice.upload("/x", bytes("x")),
      alice.mkcol("/x"),
      alice.delete("/root.txt"),
    ]) {
      expect(await kindOf(call)).toBe("server");
    }
  });
});

describe("timeouts", () => {
  it("applies the configured timeout to non-streaming calls", async () => {
    const fetchImpl = vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    const api: WebdavUserApi = createWebdavClient({
      baseUrl: "http://h/",
      fetch: fetchImpl,
      timeoutMs: 5,
    }).user(ALICE);
    expect(await kindOf(api.stat("/"))).toBe("network");
  });
});

it("uses collection URLs for stat, copy, move and delete on a strict server", async () => {
  const { server } = setup();
  const collectionPaths = new Set(["/docs", "/copy", "/moved"]);
  const fetchStrict: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (collectionPaths.has(url.pathname)) {
      return new Response(null, { status: 301, headers: { location: `${url.pathname}/` } });
    }
    if (init?.method === "COPY" || init?.method === "MOVE") {
      expect(new Headers(init.headers).get("destination")).toMatch(/\/$/);
    }
    return server.fetch(input, init);
  };
  const user = createWebdavClient({ baseUrl: "http://webdav.test/", fetch: fetchStrict }).user(
    ALICE,
  );
  expect((await user.stat("/docs")).kind).toBe("dir");
  await user.copy("/docs", "/copy");
  await user.move("/copy", "/moved");
  await user.delete("/moved");
  expect(await kindOf(user.stat("/moved"))).toBe("not_found");
});

it.each([403, 404, 500])(
  "rejects response-level and all-property %s failures within 207",
  async (status) => {
    for (const detail of [
      `<d:status>HTTP/1.1 ${status} Error</d:status>`,
      `<d:propstat><d:prop/><d:status>HTTP/1.1 ${status} Error</d:status></d:propstat>`,
    ]) {
      const client = createWebdavClient({
        baseUrl: "http://dav.test/",
        fetch: async () =>
          new Response(
            `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/file</d:href>${detail}</d:response></d:multistatus>`,
            { status: 207 },
          ),
      });
      await expect(client.user(ALICE).stat("/file")).rejects.toMatchObject({ status });
    }
  },
);

it.each(["http://evil.test/file/", "/other/", "/file/?token=x", "/file/#x"])(
  "refuses a noncanonical redirect %s",
  async (location) => {
    const redirected = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 301, headers: { location } }),
    );
    const client = createWebdavClient({ baseUrl: "http://dav.test/", fetch: redirected });
    expect(await kindOf(client.user(ALICE).stat("/file"))).toBe("server");
    expect(redirected).toHaveBeenCalledTimes(1);
  },
);
