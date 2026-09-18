import { ManagedShare, PublicShare, ShareEntriesResponse, SharesResponse } from "@fdrive/contracts";
import type { IndexedFile, IndexQueries } from "@fdrive/db";
import { createMemoryShareRepo } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { accountsHarness, cookieFrom } from "../accounts/test-fixtures/index.ts";
import { createApp } from "../app.ts";
import type { ScopeResolver } from "../scoping/resolver.ts";
import type { ThumbFileReader } from "../thumbs/serve.ts";
import { createShareCredentialCodec } from "./credentials.ts";
import { createShareLimiter } from "./limiter.ts";
import { capByteStream, contentLengthExceeds, registerSharesRoutes } from "./routes.ts";
import { createSharesService } from "./service.ts";
import { sharesHarness } from "./test-fixtures/index.ts";

function fail(name: string): never {
  throw new Error(`unexpected call to ${name} in this test`);
}

/** A minimal `IndexQueries` fake covering only the methods the public thumb route touches. */
function fakeIndexQueries(overrides: Partial<IndexQueries> = {}): IndexQueries {
  return {
    semantic: overrides.semantic ?? (async () => fail("semantic")),
    fulltext: overrides.fulltext ?? (async () => fail("fulltext")),
    filename: overrides.filename ?? (async () => fail("filename")),
    filesByIds: overrides.filesByIds ?? (async () => fail("filesByIds")),
    fileByPath: overrides.fileByPath ?? (async () => fail("fileByPath")),
    listFiles: overrides.listFiles ?? (async () => fail("listFiles")),
    filesBySha256: overrides.filesBySha256 ?? (async () => fail("filesBySha256")),
    rootIdsByName: overrides.rootIdsByName ?? (async () => fail("rootIdsByName")),
    directoriesWithFiles: overrides.directoriesWithFiles ?? (async () => []),
    stats: overrides.stats ?? (async () => fail("stats")),
    statsForFileIds: overrides.statsForFileIds ?? (async () => fail("statsForFileIds")),
    fileTextPrefix: overrides.fileTextPrefix ?? (async () => fail("fileTextPrefix")),
    duplicates: overrides.duplicates ?? (async () => fail("duplicates")),
    similar: overrides.similar ?? (async () => fail("similar")),
    recentFiles: overrides.recentFiles ?? (async () => fail("recentFiles")),
    thumbnail: overrides.thumbnail ?? (async () => fail("thumbnail")),
    recordMove: overrides.recordMove ?? (async () => fail("recordMove")),
    recentMoves: overrides.recentMoves ?? (async () => fail("recentMoves")),
    deletedRowSha: overrides.deletedRowSha ?? (async () => fail("deletedRowSha")),
    liveRowsBySha: overrides.liveRowsBySha ?? (async () => fail("liveRowsBySha")),
    searchImages: overrides.searchImages ?? (async () => fail("searchImages")),
    imageEmbeddingStats: overrides.imageEmbeddingStats ?? (async () => fail("imageEmbeddingStats")),
    subtreeSize: overrides.subtreeSize ?? (async () => fail("subtreeSize")),
  };
}

function makeIndexedFile(overrides: Partial<IndexedFile> = {}): IndexedFile {
  return {
    id: 1,
    rootId: 1,
    path: "alice/a.docx",
    name: "a.docx",
    ext: ".docx",
    size: 100,
    mtimeNs: 1n,
    sha256: "abc123",
    mime: null,
    textStatus: "done",
    textChars: 0,
    error: null,
    indexedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function fakeFileReader(overrides: Partial<ThumbFileReader> = {}): ThumbFileReader {
  return {
    stat: overrides.stat ?? (async () => ({ size: 42 })),
    readStream:
      overrides.readStream ??
      (() =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("webp-bytes"));
            controller.close();
          },
        })),
  };
}

const ALICE_HOME_SCOPES = [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }];

/** Builds a shares app wired for the public thumb route, on top of the same real fake-SFTPGo-backed harness `sharesHarness` uses. */
function sharesHarnessWithThumbs(
  overrides: {
    indexQueries?: Partial<IndexQueries>;
    resolver?: Pick<ScopeResolver, "verifiedIndexScopes">;
    /** `null` explicitly disables the route (the default is `"/thumbs"`, not disabled). */
    thumbsDir?: string | null;
    fileReader?: Partial<ThumbFileReader>;
  } = {},
) {
  const h = accountsHarness();
  const shares = createMemoryShareRepo();
  const deps = {
    ...h.deps,
    tokenSource: h.tokenSource,
    providers: h.providers,
    shares,
    logger: h.logger,
    clientFor: (_baseUrl: string) => h.client,
  };
  const service = createSharesService(deps);
  const codec = createShareCredentialCodec(h.master, h.clock);
  const limiter = createShareLimiter(h.clock);
  const resolver: Pick<ScopeResolver, "verifiedIndexScopes"> = overrides.resolver ?? {
    verifiedIndexScopes: async () => ({ available: true, scopes: ALICE_HOME_SCOPES }),
  };
  const indexQueries = fakeIndexQueries(overrides.indexQueries);
  const thumbsDir = overrides.thumbsDir === null ? undefined : (overrides.thumbsDir ?? "/thumbs");
  const fileReader = fakeFileReader(overrides.fileReader);
  const app = createApp({
    config: h.config,
    logger: h.logger,
    clock: h.clock,
    version: "test",
    startedAt: h.clock(),
    principalResolver: h.auth.principalResolver,
    registerRoutes: (groups) => {
      h.auth.registerRoutes(groups);
      registerSharesRoutes(groups, {
        service,
        codec,
        limiter,
        config: h.config,
        indexQueries,
        resolver,
        identities: h.repos.identities,
        thumbsDir,
        fileReader,
      });
    },
  });
  async function request(
    path: string,
    options: {
      method?: string;
      cookie?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    return app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  async function login(username = "alice") {
    const res = await request("/api/v1/auth/login", {
      method: "POST",
      body: { credential: { username, password: `${username}-pass` } },
    });
    return cookieFrom(res);
  }
  async function create(cookie: string, patch: Record<string, unknown> = {}) {
    const response = await request("/api/v1/shares", {
      method: "POST",
      cookie,
      body: { name: "Document", paths: ["/a.docx"], scope: "read", ...patch },
    });
    if (response.status !== 201) throw new Error(await response.text());
    return response.json() as Promise<{ id: string; hasPassword: boolean }>;
  }
  return { ...h, shares, deps, service, codec, limiter, app, request, login, create };
}

const base = "/api/v1/shares";
const publicBase = (id: string) => `/api/v1/public/shares/${id}`;
it("manages only selected session identity shares, preserves password, reconciles and revokes", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const bob = await h.login("bob");
  const share = await h.create(cookie, { password: "secret" });
  const path = `${base}/${share.id}`;
  expect((await h.request(path)).status).toBe(401);
  expect((await h.request(path, { cookie: bob })).status).toBe(404);
  expect(
    (await h.request(path, { cookie, headers: { authorization: "Bearer nope" } })).status,
  ).toBe(403);
  const get = ManagedShare.parse(await (await h.request(path, { cookie })).json());
  expect(get.publicPath).toBe(`/s/${share.id}`);
  expect(get).not.toHaveProperty("sftpgoShareId");
  expect(get.presentation).toBe("auto");
  expect(SharesResponse.parse(await (await h.request(base, { cookie })).json()).items).toHaveLength(
    1,
  );
  let response = await h.request(path, {
    cookie,
    method: "PATCH",
    body: { name: "Renamed", presentation: "gallery" },
  });
  expect(response.status).toBe(200);
  const renamed = ManagedShare.parse(await response.json());
  expect(renamed.hasPassword).toBe(true);
  expect(renamed.presentation).toBe("gallery");
  response = await h.request(path, { cookie, method: "PATCH", body: { name: "Renamed again" } });
  expect(ManagedShare.parse(await response.json()).presentation).toBe("gallery");
  expect(
    SharesResponse.parse(await (await h.request(base, { cookie })).json()).items[0]?.presentation,
  ).toBe("gallery");
  response = await h.request(path, { cookie, method: "PATCH", body: { password: "" } });
  expect(ManagedShare.parse(await response.json()).hasPassword).toBe(false);
  response = await h.request(path, { cookie, method: "PATCH", body: { password: "new" } });
  expect(ManagedShare.parse(await response.json()).hasPassword).toBe(true);
  expect((await h.request(path, { cookie, method: "PATCH", body: { allowFrom: [] } })).status).toBe(
    400,
  );
  expect((await h.request(path, { cookie, method: "DELETE" })).status).toBe(200);
  expect((await h.request(publicBase(share.id))).status).toBe(404);
  expect(
    await (
      await h.client
        .user((await h.client.login({ username: "alice", password: "alice-pass" })).accessToken)
        .download("/a.docx")
    ).body
      .getReader()
      .read(),
  ).toBeDefined();
});
it("does not let unknown share IDs exhaust limiter capacity for a real share", async () => {
  const h = sharesHarness({ limiterCapacity: 2 });
  const cookie = await h.login();
  const share = await h.create(cookie);

  for (const unknownId of [
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ]) {
    expect((await h.request(publicBase(unknownId))).status).toBe(404);
  }
  expect(
    (
      await h.request("/api/v1/public/shares/00000000-0000-4000-8000-000000000004/credentials", {
        method: "DELETE",
      })
    ).status,
  ).toBe(200);

  expect((await h.request(publicBase(share.id))).status).toBe(200);
});
it("checks cached limiter state before denied repository traffic and revalidates access", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const credentialShare = await h.create(cookie);
  const revokedShare = await h.create(cookie);
  const revokedRow = await h.shares.get(revokedShare.id);
  if (revokedRow === null) throw new Error("missing share row");
  const get = vi.spyOn(h.shares, "get");

  const unknown = publicBase("00000000-0000-4000-8000-000000000005");
  for (let request = 0; request < 120; request++) {
    expect((await h.request(unknown)).status).toBe(404);
  }
  const afterUnknownLimit = get.mock.calls.length;
  expect(afterUnknownLimit).toBe(121);
  expect((await h.request(unknown)).status).toBe(429);
  expect(get).toHaveBeenCalledTimes(afterUnknownLimit);

  const credentials = `${publicBase(credentialShare.id)}/credentials`;
  const beforeCredentials = get.mock.calls.length;
  for (let request = 0; request < 10; request++) {
    expect(
      (await h.request(credentials, { method: "POST", body: { password: "guess" } })).status,
    ).toBe(200);
  }
  expect(get.mock.calls.length - beforeCredentials).toBe(11);
  const afterCredentialLimit = get.mock.calls.length;
  expect(
    (await h.request(credentials, { method: "POST", body: { password: "guess" } })).status,
  ).toBe(429);
  expect(get).toHaveBeenCalledTimes(afterCredentialLimit);

  const revoked = publicBase(revokedShare.id);
  const beforeRevocation = get.mock.calls.length;
  expect((await h.request(revoked)).status).toBe(200);
  expect(get.mock.calls.length - beforeRevocation).toBe(2);
  await h.shares.removeOwned(revokedRow.identityId, revokedShare.id);
  expect((await h.request(revoked)).status).toBe(404);
  expect(get.mock.calls.length - beforeRevocation).toBe(3);
});
it("public password cookie is stored unverified, encrypted, scoped; metadata is withheld until it verifies; actual bytes enforce password and expiry", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const { id } = await h.create(cookie, {
    password: "secret",
    maxDownloads: 2,
    description: "Quarterly numbers",
    expiresAt: new Date(h.clock().getTime() + 86_400_000).toISOString(),
  });
  const path = publicBase(id);
  const metadata = await h.request(path);
  expect(metadata.status).toBe(200);
  // Holding the UUID alone reveals nothing beyond "protected, viewable, not expired".
  const withheld = {
    name: "",
    description: "",
    layout: "directory",
    presentation: "auto",
    fileName: null,
    hasPassword: true,
    credentialPresent: false,
    expiresAt: null,
    maxDownloads: 0,
    usedDownloads: 0,
    unavailableReason: null,
  };
  expect(PublicShare.parse(await metadata.json())).toMatchObject(withheld);
  expect((await h.request(`${path}/download`)).status).toBe(401);
  let response = await h.request(`${path}/credentials`, {
    method: "POST",
    body: { password: "wrong" },
  });
  expect(response.status).toBe(200);
  let envelope = cookieFrom(response);
  expect(response.headers.get("set-cookie")).toContain(`Path=${path}`);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(envelope).not.toContain("wrong");
  // A wrong password cookie is no better than none.
  expect(
    PublicShare.parse(await (await h.request(path, { cookie: envelope })).json()),
  ).toMatchObject(withheld);
  expect((await h.request(`${path}/download`, { cookie: envelope })).status).toBe(401);
  response = await h.request(`${path}/credentials`, {
    method: "POST",
    body: { password: "secret" },
  });
  envelope = cookieFrom(response);
  expect(
    PublicShare.parse(await (await h.request(path, { cookie: envelope })).json()),
  ).toMatchObject({
    name: "Document",
    description: "Quarterly numbers",
    layout: "single-file",
    fileName: "a.docx",
    hasPassword: true,
    credentialPresent: true,
    maxDownloads: 2,
  });
  response = await h.request(`${path}/download`, {
    cookie: envelope,
    headers: { range: "bytes=1-3" },
  });
  expect(response.status).toBe(206);
  expect(await response.text()).toBe("lic");
  expect(response.headers.get("content-range")).toContain("bytes 1-3/");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect(response.headers.get("content-disposition")).toContain("a.docx");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  response = await h.request(`${path}/download`, { cookie: envelope });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(PublicShare.parse(await (await h.request(path)).json()).unavailableReason).toBe("limit");
  expect((await h.request(`${path}/archive`, { cookie: envelope })).status).toBe(403);
  response = await h.request(`${path}/credentials`, { method: "DELETE" });
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  const exp = await h.create(cookie, {
    expiresAt: new Date(h.clock().getTime() + 1000).toISOString(),
  });
  h.now.value = new Date(h.clock().getTime() + 2000);
  expect(
    PublicShare.parse(await (await h.request(publicBase(exp.id))).json()).unavailableReason,
  ).toBe("expired");
  expect((await h.request(`${publicBase(exp.id)}/download`)).status).toBe(403);
});
it("directory listing, child downloads, zip, write-only uploads and multipath isolation", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const auth = await h.client.login({ username: "alice", password: "alice-pass" });
  const user = h.client.user(auth.accessToken);
  await user.mkdir("/folder");
  await user.upload("/folder/a.txt", new TextEncoder().encode("content"));
  const directory = await h.create(cookie, { paths: ["/folder"] });
  const dir = publicBase(directory.id);
  expect(PublicShare.parse(await (await h.request(dir)).json()).layout).toBe("directory");
  expect(
    ShareEntriesResponse.parse(await (await h.request(`${dir}/entries`)).json()).items[0]?.name,
  ).toBe("a.txt");
  expect(await (await h.request(`${dir}/download?path=/a.txt`)).text()).toBe("content");
  const zip = await h.request(`${dir}/archive`);
  expect(zip.headers.get("content-type")).toBe("application/zip");
  expect((await zip.arrayBuffer()).byteLength).toBeGreaterThan(0);
  const multi = await h.create(cookie, { paths: ["/a.docx", "/report.txt"] });
  expect(PublicShare.parse(await (await h.request(publicBase(multi.id))).json()).layout).toBe(
    "archive",
  );
  for (const suffix of ["entries", "download"])
    expect((await h.request(`${publicBase(multi.id)}/${suffix}`)).status).toBe(400);
  const write = await h.create(cookie, { paths: ["/folder"], scope: "write" });
  const upload = publicBase(write.id);
  expect(PublicShare.parse(await (await h.request(upload)).json()).layout).toBe("directory");
  for (const suffix of ["entries", "download", "archive"])
    expect((await h.request(`${upload}/${suffix}`)).status).toBe(403);
  expect(
    (await h.request(`${upload}/upload?path=/new.txt`, { method: "PUT", raw: "upload" })).status,
  ).toBe(200);
  expect(await new Response((await user.download("/folder/new.txt")).body).text()).toBe("upload");
  expect(
    (await h.request(`${dir}/upload?path=/bad.txt`, { method: "PUT", raw: "bad" })).status,
  ).toBe(403);
});
it("rejects traversal, malformed ranges, CSRF, credentials and rate abuse without data access", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const { id } = await h.create(cookie);
  const path = publicBase(id);
  for (const query of ["/../a", "/a//b", "/a\\b", "/a/."])
    expect((await h.request(`${path}/download?path=${encodeURIComponent(query)}`)).status).toBe(
      400,
    );
  expect((await h.request(`${path}/download?path=/a&path=/b`)).status).toBe(400);
  for (const range of [
    "bytes=4-2,6-7",
    "bytes=-0",
    "bytes=4-2",
    "bytes=9007199254740993-",
    "bytes=0-9007199254740993",
    "nonsense",
  ])
    expect((await h.request(`${path}/download`, { headers: { range } })).status).toBe(400);
  expect((await h.request(`${path}/upload?path=/folder/a`, { method: "PUT" })).status).toBe(400);
  expect((await h.request("/api/v1/public/shares/bad")).status).toBe(400);
  expect((await h.request(`${path}/credentials`, { method: "POST", raw: "oops" })).status).toBe(
    400,
  );
  expect(
    (await h.request(`${path}/credentials`, { method: "POST", body: { password: 3 } })).status,
  ).toBe(400);
  expect(
    (
      await h.request(`${path}/credentials`, {
        method: "POST",
        body: { password: "secret" },
        headers: { "sec-fetch-site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await h.request(`${path}/credentials`, {
        method: "POST",
        body: { password: "\0".repeat(1024) },
      })
    ).status,
  ).toBe(400);
  for (let i = 0; i < 10; i++)
    await h.request(`${path}/credentials`, { method: "POST", body: { password: "x" } });
  expect(
    (await h.request(`${path}/credentials`, { method: "POST", body: { password: "x" } })).status,
  ).toBe(429);
});

it("ignores a valid multi-range request while preserving public download accounting", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const { id } = await h.create(cookie, { maxDownloads: 2 });
  const path = publicBase(id);

  const response = await h.request(`${path}/download`, {
    headers: { range: "bytes=0-1,6-7", "if-range": "stale-validator" },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-range")).toBeNull();
  expect(await response.text()).toBe("alice data");
  expect(PublicShare.parse(await (await h.request(path)).json()).usedDownloads).toBe(1);
});
it("answers HEAD without a body, serves a suffix range, and 416s a range past the end", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const { id } = await h.create(cookie);
  const path = publicBase(id);

  const head = await h.request(`${path}/download`, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("accept-ranges")).toBe("bytes");
  expect(head.headers.get("content-length")).toBe("10");
  expect(head.headers.get("content-disposition")).toContain("a.docx");
  expect(await head.text()).toBe("");

  const tail = await h.request(`${path}/download`, { headers: { range: "bytes=-4" } });
  expect(tail.status).toBe(206);
  expect(tail.headers.get("content-range")).toBe("bytes 6-9/10");
  expect(await tail.text()).toBe("data");

  const beyond = await h.request(`${path}/download`, { headers: { range: "bytes=10-" } });
  expect(beyond.status).toBe(416);
  // The share's storage knows the size but does not say so in a 416.
  expect(beyond.headers.get("content-range")).toBeNull();
  expect(await beyond.text()).toBe("");
});
it("compensates persistence failure, sanitizes compensation failure and reconciles upstream deletions", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const auth = await h.client.login({ username: "alice", password: "alice-pass" });
  const user = h.client.user(auth.accessToken);
  const spy = vi.spyOn(h.shares, "upsert").mockRejectedValueOnce(new Error("secret DB failure"));
  const response = await h.request(base, {
    cookie,
    method: "POST",
    body: { name: "Bad", paths: ["/a.docx"], scope: "read" },
  });
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret");
  expect(await user.shares.list()).toHaveLength(0);
  spy.mockRestore();
  const share = await h.create(cookie);
  const row = await h.shares.get(share.id);
  if (!row) throw new Error("row missing");
  await user.shares.remove(row.sftpgoShareId);
  expect(SharesResponse.parse(await (await h.request(base, { cookie })).json()).items).toEqual([]);
  expect(await h.shares.get(share.id)).toBeNull();
  const gone = await h.create(cookie);
  const second = await h.shares.get(gone.id);
  if (!second) throw new Error("row missing");
  await user.shares.remove(second.sftpgoShareId);
  expect((await h.request(`${base}/${gone.id}`, { cookie, method: "DELETE" })).status).toBe(200);
  vi.spyOn(h.repos.providers, "get").mockResolvedValue(null);
  expect((await h.request(base, { cookie })).status).toBe(502);
});

describe("contentLengthExceeds", () => {
  it("is false when the header is absent", () => {
    expect(contentLengthExceeds(undefined, 100)).toBe(false);
  });

  it("is false when the header is at or under the limit", () => {
    expect(contentLengthExceeds("100", 100)).toBe(false);
    expect(contentLengthExceeds("50", 100)).toBe(false);
  });

  it("is true when the header exceeds the limit", () => {
    expect(contentLengthExceeds("101", 100)).toBe(true);
  });

  it("is false for a non-numeric header, deferring to the streaming cap", () => {
    expect(contentLengthExceeds("not-a-number", 100)).toBe(false);
  });
});

describe("capByteStream", () => {
  function streamFrom(chunks: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        index += 1;
        controller.enqueue(encoder.encode(chunk));
      },
    });
  }

  async function drain(
    stream: ReadableStream<Uint8Array>,
  ): Promise<{ chunks: Uint8Array[]; error: unknown }> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return { chunks, error: undefined };
    } catch (error) {
      return { chunks, error };
    }
  }

  it("passes every chunk through unchanged when the total stays under the cap", async () => {
    const cap = capByteStream(streamFrom(["ab", "cd"]), 10);
    const { chunks, error } = await drain(cap.stream);
    expect(error).toBeUndefined();
    expect(Buffer.concat(chunks).toString("utf-8")).toBe("abcd");
    expect(cap.exceeded()).toBe(false);
  });

  it("errors the wrapped stream and reports exceeded once the total passes the cap", async () => {
    const cap = capByteStream(streamFrom(["abcde", "fghij", "k"]), 8);
    const { error } = await drain(cap.stream);
    expect(error).toBeInstanceOf(Error);
    expect(cap.exceeded()).toBe(true);
  });

  it("reports not exceeded while nothing has been read yet", () => {
    const cap = capByteStream(streamFrom(["ab"]), 1);
    expect(cap.exceeded()).toBe(false);
  });

  it("cancels the source reader when the wrapped stream is cancelled from outside", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
      },
      cancel,
    });
    const cap = capByteStream(source, 100);
    await cap.stream.cancel("consumer gave up");
    expect(cancel).toHaveBeenCalledWith("consumer gave up");
  });
});

/** Builds a shares app whose `fdriveShareUploadMaxBytes` is `maxBytes`, to exercise the upload ceiling in `registerSharesRoutes`. */
function sharesHarnessWithUploadLimit(maxBytes: number) {
  const h = accountsHarness();
  const shares = createMemoryShareRepo();
  const deps = {
    ...h.deps,
    tokenSource: h.tokenSource,
    providers: h.providers,
    shares,
    logger: h.logger,
    clientFor: (_baseUrl: string) => h.client,
  };
  const service = createSharesService(deps);
  const codec = createShareCredentialCodec(h.master, h.clock);
  const limiter = createShareLimiter(h.clock);
  const config = { ...h.config, fdriveShareUploadMaxBytes: maxBytes };
  const app = createApp({
    config,
    logger: h.logger,
    clock: h.clock,
    version: "test",
    startedAt: h.clock(),
    principalResolver: h.auth.principalResolver,
    registerRoutes: (groups) => {
      h.auth.registerRoutes(groups);
      registerSharesRoutes(groups, {
        service,
        codec,
        limiter,
        config,
        indexQueries: {
          rootIdsByName: async () => ({}),
          fileByPath: async () => null,
          thumbnail: async () => null,
        },
        resolver: { verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }) },
        identities: h.repos.identities,
        thumbsDir: undefined,
      });
    },
  });
  async function request(
    path: string,
    options: {
      method?: string;
      cookie?: string;
      body?: unknown;
      raw?: string | ReadableStream<Uint8Array>;
      headers?: Record<string, string>;
    } = {},
  ) {
    const init: RequestInit & { duplex?: "half" } = {
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
    };
    if (options.raw instanceof ReadableStream) {
      init.duplex = "half";
    }
    return app.request(path, init);
  }
  async function login(username = "alice") {
    const res = await request("/api/v1/auth/login", {
      method: "POST",
      body: { credential: { username, password: `${username}-pass` } },
    });
    return cookieFrom(res);
  }
  async function create(cookie: string, patch: Record<string, unknown> = {}) {
    const response = await request("/api/v1/shares", {
      method: "POST",
      cookie,
      body: { name: "Document", paths: ["/a.docx"], scope: "read", ...patch },
    });
    if (response.status !== 201) throw new Error(await response.text());
    return response.json() as Promise<{ id: string; hasPassword: boolean }>;
  }
  return { ...h, shares, deps, service, codec, limiter, app, request, login, create };
}

function streamOfZeros(chunkCount: number, chunkSize: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
}

describe("PUT /public/shares/:id/upload byte ceiling", () => {
  it("rejects an upload whose declared Content-Length exceeds the configured ceiling", async () => {
    const h = sharesHarnessWithUploadLimit(10);
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    await h.client.user(auth.accessToken).mkdir("/folder");
    const { id } = await h.create(cookie, { paths: ["/folder"], scope: "write" });

    const response = await h.request(`/api/v1/public/shares/${id}/upload?path=/new.txt`, {
      method: "PUT",
      raw: "short body",
      headers: { "content-length": "1000" },
    });

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body).toMatchObject({ error: { kind: "payload_too_large" } });
  });

  it("rejects an upload whose actual streamed bytes exceed the ceiling with no Content-Length header", async () => {
    const h = sharesHarnessWithUploadLimit(10);
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    await h.client.user(auth.accessToken).mkdir("/folder");
    const { id } = await h.create(cookie, { paths: ["/folder"], scope: "write" });

    const response = await h.request(`/api/v1/public/shares/${id}/upload?path=/new.txt`, {
      method: "PUT",
      raw: streamOfZeros(5, 5),
    });

    expect(response.status).toBe(413);
  });

  it("allows an upload at or under the configured ceiling", async () => {
    const h = sharesHarnessWithUploadLimit(1024);
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    const user = h.client.user(auth.accessToken);
    await user.mkdir("/folder");
    const { id } = await h.create(cookie, { paths: ["/folder"], scope: "write" });

    const response = await h.request(`/api/v1/public/shares/${id}/upload?path=/new.txt`, {
      method: "PUT",
      raw: "small",
    });

    expect(response.status).toBe(200);
    expect(await new Response((await user.download("/folder/new.txt")).body).text()).toBe("small");
  });

  it("uploads an empty body (no request body at all) without wrapping it in a byte cap", async () => {
    const h = sharesHarnessWithUploadLimit(1024);
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    const user = h.client.user(auth.accessToken);
    await user.mkdir("/folder");
    const { id } = await h.create(cookie, { paths: ["/folder"], scope: "write" });

    const response = await h.request(`/api/v1/public/shares/${id}/upload?path=/empty.txt`, {
      method: "PUT",
    });

    expect(response.status).toBe(200);
    expect(await new Response((await user.download("/folder/empty.txt")).body).text()).toBe("");
  });

  it("does not relabel an unrelated upload failure under the cap as payload_too_large", async () => {
    const h = sharesHarnessWithUploadLimit(1024);
    const cookie = await h.login();
    // No mkdir("/folder"): the shared directory never existed upstream, so the
    // upload fails for a reason unrelated to the byte cap.
    const { id } = await h.create(cookie, { paths: ["/folder"], scope: "write" });

    const response = await h.request(`/api/v1/public/shares/${id}/upload?path=/new.txt`, {
      method: "PUT",
      raw: "small",
    });

    expect(response.status).not.toBe(413);
  });
});

describe("GET /public/shares/:id/thumb", () => {
  it("streams the shared file's own thumbnail with the expected headers", async () => {
    const fileByPath = vi.fn(async () => makeIndexedFile());
    const h = sharesHarnessWithThumbs({
      indexQueries: {
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath,
        thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
      },
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-length")).toBe("42");
    // The one public share response that is not "no-store": a gallery
    // re-renders its tiles constantly and the lightbox preloads its
    // neighbours, and neither is worth anything against a store that keeps
    // nothing. Bounded to a minute, and "private" so no shared proxy cache
    // ever holds it.
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    expect(res.headers.get("etag")).toBe('"abc123"');
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe("webp-bytes");
    expect(fileByPath).toHaveBeenCalledWith(1, "alice/a.docx");
  });

  it("leaves every other public share response on the blanket no-store", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/download?path=%2F`);

    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("defaults path to the shared root when omitted", async () => {
    const fileByPath = vi.fn(async () => makeIndexedFile());
    const h = sharesHarnessWithThumbs({
      indexQueries: {
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath,
        thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
      },
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?size=256`);

    expect(res.status).toBe(200);
    expect(fileByPath).toHaveBeenCalledWith(1, "alice/a.docx");
  });

  it("streams a thumbnail for a file inside a directory share", async () => {
    const fileByPath = vi.fn(async () => makeIndexedFile({ path: "alice/folder/photo.jpg" }));
    const h = sharesHarnessWithThumbs({
      indexQueries: {
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath,
        thumbnail: async () => ({ storagePath: "ab/abc123.1024.webp" }),
      },
    });
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    await h.client.user(auth.accessToken).mkdir("/folder");
    const { id } = await h.create(cookie, { paths: ["/folder"] });

    const res = await h.request(`${publicBase(id)}/thumb?path=%2Fphoto.jpg&size=1024`);

    expect(res.status).toBe(200);
    expect(fileByPath).toHaveBeenCalledWith(1, "alice/folder/photo.jpg");
  });

  it("404s when thumbnails are not configured", async () => {
    const h = sharesHarnessWithThumbs({ thumbsDir: null });
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { kind: string } }).toMatchObject({
      error: { kind: "not_found" },
    });
  });

  it("404s for a size outside THUMB_SIZES", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=512`);

    expect(res.status).toBe(404);
  });

  it("404s for a missing size", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F`);

    expect(res.status).toBe(404);
  });

  it("404s for a repeated path query parameter", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2Fa&path=%2Fb&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s for every path SharePath already rejects, instead of adding a second sanitiser", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    for (const path of ["..%2F", "/a/../b", "//", "/a\\b", "C:\\Windows\\win.ini"]) {
      const res = await h.request(
        `${publicBase(id)}/thumb?path=${encodeURIComponent(path)}&size=256`,
      );
      expect(res.status).toBe(404);
    }
  });

  it("404s for a path segment over 255 bytes, which SharePath allows but normalization rejects", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(
      `${publicBase(id)}/thumb?path=${encodeURIComponent(`/${"a".repeat(300)}.jpg`)}&size=256`,
    );

    expect(res.status).toBe(404);
  });

  it("404s for an unknown share", async () => {
    const h = sharesHarnessWithThumbs();

    const res = await h.request(
      "/api/v1/public/shares/00000000-0000-4000-8000-000000000000/thumb?path=%2F&size=256",
    );

    expect(res.status).toBe(404);
  });

  it("404s for a write-scope share", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const auth = await h.client.login({ username: "alice", password: "alice-pass" });
    await h.client.user(auth.accessToken).mkdir("/folder");
    const { id } = await h.create(cookie, { paths: ["/folder"], scope: "write" });

    const res = await h.request(`${publicBase(id)}/thumb?path=%2Fa.jpg&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s for an archive share (more than one shared path)", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { paths: ["/a.docx", "/report.txt"] });

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s for an expired share", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie, {
      expiresAt: new Date(h.clock().getTime() + 1000).toISOString(),
    });
    h.now.value = new Date(h.clock().getTime() + 2000);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s for a limit-reached share", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { maxDownloads: 1 });
    await h.request(`${publicBase(id)}/download`);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s for a password-protected share with no credential cookie", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { password: "secret" });

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s for a password-protected share with the wrong password", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { password: "secret" });
    const path = publicBase(id);
    const credentials = await h.request(`${path}/credentials`, {
      method: "POST",
      body: { password: "wrong" },
    });
    const envelope = cookieFrom(credentials);

    const res = await h.request(`${path}/thumb?path=%2F&size=256`, { cookie: envelope });

    expect(res.status).toBe(404);
  });

  it("streams the thumbnail once the correct password cookie is set, and caches the check", async () => {
    const h = sharesHarnessWithThumbs({
      indexQueries: {
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => makeIndexedFile(),
        thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
      },
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie, { password: "secret" });
    const path = publicBase(id);
    const credentials = await h.request(`${path}/credentials`, {
      method: "POST",
      body: { password: "secret" },
    });
    const envelope = cookieFrom(credentials);
    const verify = vi.spyOn(h.service, "verifySharePassword");

    const first = await h.request(`${path}/thumb?path=%2F&size=256`, { cookie: envelope });
    const second = await h.request(`${path}/thumb?path=%2F&size=256`, { cookie: envelope });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("404s when the file is not indexed", async () => {
    const h = sharesHarnessWithThumbs({
      indexQueries: {
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => null,
      },
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s when the indexed file has no sha256", async () => {
    const h = sharesHarnessWithThumbs({
      indexQueries: {
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => makeIndexedFile({ sha256: null }),
      },
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s when no thumbnail has been generated for that size", async () => {
    const h = sharesHarnessWithThumbs({
      indexQueries: {
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => makeIndexedFile(),
        thumbnail: async () => null,
      },
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s when the cached thumbnail file is missing from disk", async () => {
    const h = sharesHarnessWithThumbs({
      indexQueries: {
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => makeIndexedFile(),
        thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
      },
      fileReader: {
        stat: async () => {
          throw new Error("ENOENT");
        },
      },
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s when the path cannot be resolved to a configured root", async () => {
    const h = sharesHarnessWithThumbs({
      indexQueries: { rootIdsByName: async () => ({}) },
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s when the owner's verified index scopes are unavailable", async () => {
    const h = sharesHarnessWithThumbs({
      resolver: { verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }) },
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s when the owner's scopes do not cover the shared path", async () => {
    const h = sharesHarnessWithThumbs({
      resolver: { verifiedIndexScopes: async () => ({ available: true, scopes: [] }) },
    });
    const cookie = await h.login();
    const { id } = await h.create(cookie);

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
  });

  it("404s when the owning identity no longer exists", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie);
    // `publicThumbTarget` itself resolves the owner's connection (three
    // calls to `identities.get`: twice from the service's `owner()`
    // helper, once from the token source's client resolution) before the
    // route makes its own separate lookup; only that fourth, route-level
    // call should see a missing identity here.
    const original = h.repos.identities.get.bind(h.repos.identities);
    let calls = 0;
    vi.spyOn(h.repos.identities, "get").mockImplementation(async (identityId) => {
      calls += 1;
      return calls > 3 ? null : original(identityId);
    });

    const res = await h.request(`${publicBase(id)}/thumb?path=%2F&size=256`);

    expect(res.status).toBe(404);
    expect(calls).toBe(4);
  });

  it("404s when verifying the password throws for a reason other than a wrong password", async () => {
    const h = sharesHarnessWithThumbs();
    const cookie = await h.login();
    const { id } = await h.create(cookie, { password: "secret" });
    const path = publicBase(id);
    const credentials = await h.request(`${path}/credentials`, {
      method: "POST",
      body: { password: "secret" },
    });
    const envelope = cookieFrom(credentials);
    vi.spyOn(h.service, "verifySharePassword").mockRejectedValueOnce(new Error("upstream down"));

    const res = await h.request(`${path}/thumb?path=%2F&size=256`, { cookie: envelope });

    expect(res.status).toBe(404);
  });
});

it("a password-protected upload share withholds its details for everyone: no listing can verify its password", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const auth = await h.client.login({ username: "alice", password: "alice-pass" });
  await h.client.user(auth.accessToken).mkdir("/inbox");
  const { id } = await h.create(cookie, {
    name: "Send me the contract",
    paths: ["/inbox"],
    scope: "write",
    password: "secret",
  });
  const path = publicBase(id);
  const anonymous = PublicShare.parse(await (await h.request(path)).json());
  expect(anonymous).toMatchObject({
    name: "",
    scope: "write",
    hasPassword: true,
    credentialPresent: false,
  });
  const envelope = cookieFrom(
    await h.request(`${path}/credentials`, { method: "POST", body: { password: "secret" } }),
  );
  const withCookie = PublicShare.parse(await (await h.request(path, { cookie: envelope })).json());
  expect(withCookie).toMatchObject({ name: "", scope: "write", credentialPresent: true });
  // An unprotected share still shows everything to anyone with the link.
  const open = await h.create(cookie, { name: "Open inbox", paths: ["/inbox"], scope: "write" });
  expect(PublicShare.parse(await (await h.request(publicBase(open.id))).json())).toMatchObject({
    name: "Open inbox",
    credentialPresent: false,
  });
});
it("rotating or removing a share password drops memoized thumbnail verifications at once", async () => {
  const h = sharesHarnessWithThumbs({
    indexQueries: {
      rootIdsByName: async () => ({ sftpgo: 1 }),
      fileByPath: async () => makeIndexedFile(),
      thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
    },
  });
  const cookie = await h.login();
  const { id } = await h.create(cookie, { password: "secret" });
  const path = publicBase(id);
  const envelope = cookieFrom(
    await h.request(`${path}/credentials`, { method: "POST", body: { password: "secret" } }),
  );
  const thumb = `${path}/thumb?path=%2F&size=256`;
  expect((await h.request(thumb, { cookie: envelope })).status).toBe(200);
  expect(
    (
      await h.request(`${base}/${id}`, {
        method: "PATCH",
        cookie,
        body: { password: "rotated" },
      })
    ).status,
  ).toBe(200);
  // Still within the cache TTL, yet the old password no longer serves thumbnails.
  expect((await h.request(thumb, { cookie: envelope })).status).toBe(404);
  const rotated = cookieFrom(
    await h.request(`${path}/credentials`, { method: "POST", body: { password: "rotated" } }),
  );
  expect((await h.request(thumb, { cookie: rotated })).status).toBe(200);
  expect((await h.request(`${base}/${id}`, { method: "DELETE", cookie })).status).toBe(200);
  expect((await h.request(thumb, { cookie: rotated })).status).toBe(404);
});

// SFTPGo stores a share's download limit in `max_tokens`, declared `integer` by
// its PostgreSQL and MySQL data providers, so anything past signed 32-bit must be
// refused at the edge instead of being forwarded to a provider that cannot hold it.
it("refuses download limits past the SFTPGo counter column on create and update", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const overLimit = 2_147_483_648;
  const created = await h.create(cookie, { maxDownloads: 2_147_483_647 });
  const path = `${base}/${created.id}`;

  expect(
    (
      await h.request(base, {
        cookie,
        method: "POST",
        body: { name: "Too many", paths: ["/a.docx"], scope: "read", maxDownloads: overLimit },
      })
    ).status,
  ).toBe(400);
  expect(
    (await h.request(path, { cookie, method: "PATCH", body: { maxDownloads: overLimit } })).status,
  ).toBe(400);
  // The boundary itself stays usable, and the rejected update left the share alone.
  expect(ManagedShare.parse(await (await h.request(path, { cookie })).json()).maxDownloads).toBe(
    2_147_483_647,
  );
});

// A share created before the limit was bounded still lives in SFTPGo, and the
// update path re-validates the whole merged share, so its stored limit must not
// turn every later edit into an upstream failure.
it("still edits a share whose stored download limit predates the bound", async () => {
  const h = sharesHarness();
  const cookie = await h.login();
  const created = await h.create(cookie, { maxDownloads: 5 });
  const auth = await h.client.login({ username: "alice", password: "alice-pass" });
  const user = h.client.user(auth.accessToken);
  const [stored] = await user.shares.list();
  if (!stored) throw new Error("Missing seeded share");
  await user.shares.update(stored.id, {
    name: stored.name,
    scope: stored.scope,
    paths: stored.paths,
    maxTokens: Number.MAX_SAFE_INTEGER,
  });

  const path = `${base}/${created.id}`;
  expect(
    (await h.request(path, { cookie, method: "PATCH", body: { name: "Renamed" } })).status,
  ).toBe(200);
  const after = ManagedShare.parse(await (await h.request(path, { cookie })).json());
  expect(after.name).toBe("Renamed");
  expect(after.maxDownloads).toBe(2_147_483_647);
});
