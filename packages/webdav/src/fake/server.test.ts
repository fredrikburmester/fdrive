import { describe, expect, it } from "vitest";
import { createFakeWebdavServer, type FakeWebdavOptions } from "./server.js";

const AUTH = `Basic ${Buffer.from("alice:secret").toString("base64")}`;

function server(options: Partial<FakeWebdavOptions> = {}) {
  return createFakeWebdavServer({
    users: [
      { username: "alice", password: "secret" },
      { username: "bob", password: "pw", readOnly: true },
    ],
    files: { "/docs/a.txt": "hello" },
    ...options,
  });
}

function call(
  fake: ReturnType<typeof createFakeWebdavServer>,
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: RequestInit["body"]; auth?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.auth !== null) headers.Authorization = init.auth ?? AUTH;
  const request: RequestInit = { method, headers };
  if (init.body !== undefined) request.body = init.body;
  return fake.fetch(`http://webdav.test${path}`, request);
}

describe("fake WebDAV server: routing and authentication", () => {
  it("rejects other origins like an unreachable host", async () => {
    await expect(server().fetch("http://other.test/")).rejects.toThrow(/unknown host/);
  });

  it("throws an AbortError for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      server().fetch("http://webdav.test/", { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });

  it("answers 404 outside the prefix and 400 for malformed encoding", async () => {
    const fake = server({ prefix: "/dav" });
    expect((await call(fake, "PROPFIND", "/elsewhere", { headers: { Depth: "0" } })).status).toBe(
      404,
    );
    expect((await call(fake, "PROPFIND", "/dav/%ZZ", { headers: { Depth: "0" } })).status).toBe(
      400,
    );
    expect((await call(fake, "PROPFIND", "/dav", { headers: { Depth: "0" } })).status).toBe(207);
  });

  it("challenges missing, malformed and wrong credentials", async () => {
    const fake = server();
    const missing = await call(fake, "PROPFIND", "/", { auth: null, headers: { Depth: "0" } });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Basic realm="fake"');
    expect((await call(fake, "PROPFIND", "/", { auth: "Bearer x" })).status).toBe(401);
    const noColon = `Basic ${Buffer.from("alice").toString("base64")}`;
    expect((await call(fake, "PROPFIND", "/", { auth: noColon })).status).toBe(401);
    const unknown = `Basic ${Buffer.from("carol:x").toString("base64")}`;
    expect((await call(fake, "PROPFIND", "/", { auth: unknown })).status).toBe(401);
  });

  it("answers OPTIONS anonymously by default, or only when authenticated", async () => {
    const open = await call(server(), "OPTIONS", "/", { auth: null });
    expect(open.status).toBe(200);
    expect(open.headers.get("dav")).toBe("1, 2");
    expect(open.headers.get("allow")).toContain("PROPFIND");
    const closed = server({ anonymousOptions: false });
    expect((await call(closed, "OPTIONS", "/", { auth: null })).status).toBe(401);
    expect((await call(closed, "OPTIONS", "/")).status).toBe(200);
  });

  it("redirects everything when configured and rejects unknown methods", async () => {
    const redirecting = await call(server({ redirectTo: "http://x/" }), "GET", "/docs/a.txt");
    expect(redirecting.status).toBe(302);
    expect(redirecting.headers.get("location")).toBe("http://x/");
    expect((await call(server(), "PATCH", "/docs/a.txt")).status).toBe(405);
  });

  it("records every request with its headers", async () => {
    const fake = server();
    await call(fake, "PROPFIND", "/", { headers: { Depth: "0" } });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: "PROPFIND", headers: { depth: "0" } });
  });
});

describe("fake WebDAV server: PROPFIND", () => {
  it("refuses Depth infinity and a missing Depth", async () => {
    const fake = server();
    expect((await call(fake, "PROPFIND", "/")).status).toBe(403);
    expect((await call(fake, "PROPFIND", "/", { headers: { Depth: "infinity" } })).status).toBe(
      403,
    );
  });

  it("answers 404 for a missing resource and lists members at Depth 1", async () => {
    const fake = server();
    expect((await call(fake, "PROPFIND", "/nope", { headers: { Depth: "0" } })).status).toBe(404);
    const listing = await (
      await call(fake, "PROPFIND", "/docs/", { headers: { Depth: "1" } })
    ).text();
    expect(listing).toContain("<D:href>/docs/</D:href>");
    expect(listing).toContain("<D:href>/docs/a.txt</D:href>");
    expect(listing).toContain("<D:getcontentlength>5</D:getcontentlength>");
    expect(listing).toContain("<D:displayname>a.txt</D:displayname>");
    const single = await (
      await call(fake, "PROPFIND", "/docs/a.txt", { headers: { Depth: "1" } })
    ).text();
    expect(single).not.toContain("<D:collection/>");
  });

  it("escapes names and emits the configured href and namespace styles", async () => {
    const fake = server({
      hrefStyle: "absolute",
      namespaceStyle: "default",
      prefix: "/dav",
      files: { "/a&b<c>.txt": "x" },
    });
    const body = await (await call(fake, "PROPFIND", "/dav/", { headers: { Depth: "1" } })).text();
    expect(body).toContain('<multistatus xmlns="DAV:">');
    expect(body).toContain("<href>http://webdav.test/dav/</href>");
    expect(body).toContain("<href>http://webdav.test/dav/a%26b%3Cc%3E.txt</href>");
    expect(body).toContain("<displayname>a&amp;b&lt;c&gt;.txt</displayname>");
  });
});

describe("fake WebDAV server: GET and HEAD", () => {
  it("serves files with metadata and refuses collections", async () => {
    const fake = server();
    const response = await call(fake, "GET", "/docs/a.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toMatch(/^"5-/);
    expect(await response.text()).toBe("hello");
    expect((await call(fake, "GET", "/docs")).status).toBe(405);
    expect((await call(fake, "GET", "/nope")).status).toBe(404);
    const head = await call(fake, "HEAD", "/docs/a.txt");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("serves a file stored without a content type", async () => {
    const fake = server();
    await call(fake, "PUT", "/raw", { body: new Uint8Array([1, 2]) });
    const response = await call(fake, "GET", "/raw");
    expect(response.headers.get("content-type")).toBeNull();
    const listing = await (
      await call(fake, "PROPFIND", "/raw", { headers: { Depth: "0" } })
    ).text();
    expect(listing).not.toContain("getcontenttype");
  });

  it("serves byte ranges, suffix ranges and 416 for unsatisfiable ones", async () => {
    const fake = server();
    const range = await call(fake, "GET", "/docs/a.txt", { headers: { Range: "bytes=1-2" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 1-2/5");
    expect(await range.text()).toBe("el");
    const suffix = await call(fake, "GET", "/docs/a.txt", { headers: { Range: "bytes=-2" } });
    expect(await suffix.text()).toBe("lo");
    const clamped = await call(fake, "GET", "/docs/a.txt", { headers: { Range: "bytes=3-99" } });
    expect(clamped.headers.get("content-range")).toBe("bytes 3-4/5");
    const headRange = await call(fake, "HEAD", "/docs/a.txt", { headers: { Range: "bytes=0-0" } });
    expect(headRange.status).toBe(206);
    for (const header of ["bytes=9-", "bytes=-0"]) {
      const bad = await call(fake, "GET", "/docs/a.txt", { headers: { Range: header } });
      expect(bad.status).toBe(416);
      expect(bad.headers.get("content-range")).toBe("bytes */5");
    }
    for (const header of ["items=1-2", "bytes=-", "bytes=3-1"]) {
      expect((await call(fake, "GET", "/docs/a.txt", { headers: { Range: header } })).status).toBe(
        200,
      );
    }
    const empty = server({ files: { "/e": "" } });
    expect((await call(empty, "GET", "/e", { headers: { Range: "bytes=-1" } })).status).toBe(416);
  });

  it("applies If-Range against the etag or last-modified and can disable ranges", async () => {
    const fake = server();
    const meta = await call(fake, "HEAD", "/docs/a.txt");
    const etag = meta.headers.get("etag") ?? "";
    const modified = meta.headers.get("last-modified") ?? "";
    for (const validator of [etag, modified]) {
      const hit = await call(fake, "GET", "/docs/a.txt", {
        headers: { Range: "bytes=0-0", "If-Range": validator },
      });
      expect(hit.status).toBe(206);
    }
    const miss = await call(fake, "GET", "/docs/a.txt", {
      headers: { Range: "bytes=0-0", "If-Range": '"other"' },
    });
    expect(miss.status).toBe(200);
    const noRanges = server({ rangeSupport: false });
    expect(
      (await call(noRanges, "GET", "/docs/a.txt", { headers: { Range: "bytes=0-0" } })).status,
    ).toBe(200);
  });
});

describe("fake WebDAV server: writes", () => {
  it("PUT creates, overwrites, honours If-None-Match and X-OC-Mtime, and rejects bad targets", async () => {
    const fake = server();
    expect((await call(fake, "PUT", "/new.txt", { body: "one" })).status).toBe(201);
    expect((await call(fake, "PUT", "/new.txt", { body: "two" })).status).toBe(204);
    expect(
      (await call(fake, "PUT", "/new.txt", { body: "x", headers: { "If-None-Match": "*" } }))
        .status,
    ).toBe(412);
    const stamped = await call(fake, "PUT", "/stamped.txt", {
      body: "x",
      headers: { "X-OC-Mtime": "1600000000" },
    });
    expect(stamped.headers.get("x-oc-mtime")).toBe("accepted");
    expect(fake.volume.get("/stamped.txt")?.modifiedAt.getTime()).toBe(1_600_000_000_000);
    expect(
      (await call(fake, "PUT", "/odd.txt", { body: "x", headers: { "X-OC-Mtime": "soon" } }))
        .status,
    ).toBe(201);
    expect((await call(fake, "PUT", "/", { body: "x" })).status).toBe(405);
    expect((await call(fake, "PUT", "/docs", { body: "x" })).status).toBe(405);
    expect((await call(fake, "PUT", "/nope/x", { body: "x" })).status).toBe(409);
    expect((await call(fake, "PUT", "/docs/a.txt/x", { body: "x" })).status).toBe(409);
  });

  it("MKCOL creates one collection and rejects duplicates, orphans and bodies", async () => {
    const fake = server();
    expect((await call(fake, "MKCOL", "/made/")).status).toBe(201);
    expect((await call(fake, "MKCOL", "/made")).status).toBe(405);
    expect((await call(fake, "MKCOL", "/nope/x")).status).toBe(409);
    expect((await call(fake, "MKCOL", "/withbody", { body: "<x/>" })).status).toBe(415);
  });

  it("DELETE removes files and trees but never the root", async () => {
    const fake = server();
    expect((await call(fake, "DELETE", "/docs")).status).toBe(204);
    expect(fake.volume.has("/docs/a.txt")).toBe(false);
    expect((await call(fake, "DELETE", "/docs")).status).toBe(404);
    expect((await call(fake, "DELETE", "/")).status).toBe(403);
  });

  it("refuses every write for a read-only user", async () => {
    const fake = server();
    const bob = `Basic ${Buffer.from("bob:pw").toString("base64")}`;
    for (const method of ["PUT", "MKCOL", "DELETE", "MOVE", "COPY"]) {
      expect((await call(fake, method, "/docs/a.txt", { auth: bob })).status).toBe(403);
    }
    expect((await call(fake, "GET", "/docs/a.txt", { auth: bob })).status).toBe(200);
  });
});

describe("fake WebDAV server: COPY and MOVE", () => {
  const dest = (path: string) => ({ Destination: `http://webdav.test${path}` });

  it("validates the Destination header", async () => {
    const fake = server();
    expect((await call(fake, "MOVE", "/docs/a.txt")).status).toBe(400);
    expect(
      (await call(fake, "MOVE", "/docs/a.txt", { headers: { Destination: "http://[bad" } })).status,
    ).toBe(400);
    expect(
      (await call(fake, "MOVE", "/docs/a.txt", { headers: { Destination: "http://other.test/x" } }))
        .status,
    ).toBe(502);
    const prefixed = server({ prefix: "/dav" });
    expect(
      (await call(prefixed, "MOVE", "/dav/docs/a.txt", { headers: dest("/outside/x") })).status,
    ).toBe(502);
    expect(
      (await call(prefixed, "MOVE", "/dav/docs/a.txt", { headers: dest("/dav/%ZZ") })).status,
    ).toBe(400);
    expect(
      (await call(prefixed, "MOVE", "/dav/docs/a.txt", { headers: { Destination: "/dav/b" } }))
        .status,
    ).toBe(201);
  });

  it("refuses moving the root, onto itself, onto the root or into itself", async () => {
    const fake = server();
    expect((await call(fake, "MOVE", "/", { headers: dest("/x") })).status).toBe(403);
    expect((await call(fake, "MOVE", "/docs", { headers: dest("/docs") })).status).toBe(403);
    expect((await call(fake, "MOVE", "/docs", { headers: dest("/") })).status).toBe(403);
    expect((await call(fake, "MOVE", "/docs", { headers: dest("/docs/inner") })).status).toBe(403);
    expect((await call(fake, "MOVE", "/nope", { headers: dest("/x") })).status).toBe(404);
  });

  it("honours Overwrite, requires the target parent and reports created versus replaced", async () => {
    const fake = server();
    await call(fake, "PUT", "/b.txt", { body: "b" });
    expect(
      (await call(fake, "COPY", "/docs/a.txt", { headers: { ...dest("/b.txt"), Overwrite: "F" } }))
        .status,
    ).toBe(412);
    expect(
      (await call(fake, "COPY", "/docs/a.txt", { headers: { ...dest("/b.txt"), Overwrite: "T" } }))
        .status,
    ).toBe(204);
    expect(await (await call(fake, "GET", "/b.txt")).text()).toBe("hello");
    expect((await call(fake, "COPY", "/docs/a.txt", { headers: dest("/nope/c.txt") })).status).toBe(
      409,
    );
    expect(
      (await call(fake, "COPY", "/docs", { headers: { ...dest("/shallow"), Depth: "0" } })).status,
    ).toBe(201);
    expect(fake.volume.has("/shallow/a.txt")).toBe(false);
    expect((await call(fake, "MOVE", "/docs", { headers: dest("/moved") })).status).toBe(201);
    expect(fake.volume.has("/moved/a.txt")).toBe(true);
    expect(fake.volume.has("/docs")).toBe(false);
  });
});
