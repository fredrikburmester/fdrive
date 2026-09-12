import { describe, expect, it, vi } from "vitest";
import { createFakeWebdavServer } from "./fake/server.js";
import { candidateProblem, davClasses, probeConnection } from "./probe.js";

function answering(response: () => Response): typeof globalThis.fetch {
  return vi.fn(async () => response()) as unknown as typeof globalThis.fetch;
}

describe("candidateProblem", () => {
  it.each([
    ["not a url", "WebDAV URL is invalid"],
    ["ftp://host/", "WebDAV URL must use http or https"],
    ["http://u:p@host/", "WebDAV URL must not include credentials"],
    ["http://169.254.169.254/", "WebDAV URL targets a prohibited metadata host"],
    ["http://[fd00:ec2::254]/", "WebDAV URL targets a prohibited metadata host"],
    ["http://METADATA.google.internal/", "WebDAV URL targets a prohibited metadata host"],
  ])("rejects %s", (url, detail) => {
    expect(candidateProblem(url)).toBe(detail);
  });

  it("accepts an ordinary endpoint", () => {
    expect(candidateProblem("https://files.example/dav")).toBeNull();
  });
});

describe("davClasses", () => {
  it("splits, trims and lower-cases the header", () => {
    expect(davClasses("1, 2, extended-mkcol")).toEqual(["1", "2", "extended-mkcol"]);
    expect(davClasses(" 1 ,,")).toEqual(["1"]);
    expect(davClasses(null)).toEqual([]);
  });
});

describe("probeConnection", () => {
  it("refuses a bad candidate before any request", async () => {
    const fetchImpl = answering(() => new Response(null));
    expect(await probeConnection("ftp://host/", { fetch: fetchImpl })).toEqual({
      ok: false,
      detail: "WebDAV URL must use http or https",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends OPTIONS to the endpoint with a trailing slash and accepts a class 1 answer", async () => {
    const server = createFakeWebdavServer({ users: [], prefix: "/dav" });
    expect(await probeConnection("http://webdav.test/dav", { fetch: server.fetch })).toEqual({
      ok: true,
      detail: "WebDAV is reachable (class 1, 2)",
    });
    expect(server.requests[0]).toMatchObject({ method: "OPTIONS", url: "http://webdav.test/dav/" });
  });

  it("reports an unreachable host", async () => {
    const server = createFakeWebdavServer({ users: [] });
    const result = await probeConnection("http://elsewhere.test/", { fetch: server.fetch });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/could not reach http:\/\/elsewhere.test/);
  });

  it("describes a non-Error rejection", async () => {
    const fetchImpl = vi.fn(async () => {
      throw "odd";
    }) as unknown as typeof globalThis.fetch;
    expect((await probeConnection("http://h/", { fetch: fetchImpl })).detail).toMatch(
      /network error/,
    );
  });

  it("refuses redirects", async () => {
    const server = createFakeWebdavServer({ users: [], redirectTo: "http://other/" });
    expect(await probeConnection("http://webdav.test/", { fetch: server.fetch })).toEqual({
      ok: false,
      detail: "OPTIONS redirected with 302; enter the final endpoint URL",
    });
  });

  it("accepts a Basic challenge as a reachable endpoint", async () => {
    const server = createFakeWebdavServer({ users: [], anonymousOptions: false });
    expect(await probeConnection("http://webdav.test/", { fetch: server.fetch })).toEqual({
      ok: true,
      detail: "WebDAV endpoint is reachable and requires a login",
    });
  });

  it("refuses a challenge without Basic or without any challenge", async () => {
    const digest = createFakeWebdavServer({
      users: [],
      anonymousOptions: false,
      challenge: 'Digest realm="x"',
    });
    expect((await probeConnection("http://webdav.test/", { fetch: digest.fetch })).detail).toBe(
      "OPTIONS returned 401 without offering Basic authentication",
    );
    const none = createFakeWebdavServer({ users: [], anonymousOptions: false, challenge: null });
    expect((await probeConnection("http://webdav.test/", { fetch: none.fetch })).detail).toBe(
      "OPTIONS returned 401 without an authentication challenge",
    );
    const forbidden = answering(
      () => new Response(null, { status: 403, headers: { "WWW-Authenticate": "Bearer" } }),
    );
    expect((await probeConnection("http://h/", { fetch: forbidden })).detail).toBe(
      "OPTIONS returned 403 without offering Basic authentication",
    );
  });

  it("refuses other statuses and answers without or with an insufficient DAV header", async () => {
    expect(
      (
        await probeConnection("http://h/", {
          fetch: answering(() => new Response(null, { status: 500 })),
        })
      ).detail,
    ).toBe("OPTIONS returned 500, expected 200");
    const noDav = createFakeWebdavServer({ users: [], dav: null });
    expect((await probeConnection("http://webdav.test/", { fetch: noDav.fetch })).detail).toBe(
      "OPTIONS did not return a DAV header; not a WebDAV endpoint",
    );
    const classTwo = createFakeWebdavServer({ users: [], dav: "2" });
    expect((await probeConnection("http://webdav.test/", { fetch: classTwo.fetch })).detail).toBe(
      "DAV header lacks class 1 (got 2)",
    );
  });
});

it.each(["http://dav.test/?query=x", "http://dav.test/#fragment"])(
  "rejects URL components that requests would discard: %s",
  async (url) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect((await probeConnection(url, { fetch })).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  },
);
