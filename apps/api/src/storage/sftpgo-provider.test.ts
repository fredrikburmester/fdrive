import type { StorageErrorKind } from "@fdrive/core";
import { isStorageError } from "@fdrive/core";
import { createFakeSftpgoServer, createSftpgoClient, type FakeSeed } from "@fdrive/sftpgo";
import { describe, expect, it } from "vitest";
import {
  createSftpgoStorageProvider,
  type SftpgoDownloadOpts,
  type WithToken,
} from "./sftpgo-provider.js";

const FULL_PERMS = ["*"];

function setup(seed: FakeSeed) {
  const server = createFakeSftpgoServer(seed);
  const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
  return { server, client };
}

/** A `WithToken` that logs in once as `username` and reuses that token for every call. */
async function withTokenFor(
  client: ReturnType<typeof createSftpgoClient>,
  username: string,
  password: string,
): Promise<WithToken> {
  const token = await client.login({ username, password });
  return async (fn) => fn(token.accessToken);
}

const ALICE_SEED: FakeSeed = {
  users: [
    { username: "alice", password: "secret", permissions: { "/": FULL_PERMS } },
    { username: "bob", password: "secret2", permissions: { "/": FULL_PERMS } },
  ],
  files: {
    alice: {
      "/hello.txt": "hello world",
    },
  },
};

describe("createSftpgoStorageProvider - happy paths against the fake server", () => {
  it("lists a directory, converting entries to FileEntry", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    const entries = await provider.list("/");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "hello.txt",
      path: "/hello.txt",
      kind: "file",
      size: 11,
      ext: ".txt",
    });
    expect(entries[0]?.modifiedAt).toBeInstanceOf(Date);
  });

  it("normalizes the listed path before calling SFTPGo", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    const entries = await provider.list("//./");

    expect(entries.map((e) => e.path)).toEqual(["/hello.txt"]);
  });

  it("stats a file", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    const stat = await provider.statFile("/hello.txt");

    expect(stat.size).toBe(11);
    expect(stat.modifiedAt).toBeInstanceOf(Date);
  });

  it("downloads a whole file", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    const result = await provider.download("/hello.txt");

    expect(result.status).toBe(200);
    const text = await new Response(result.body).text();
    expect(text).toBe("hello world");
  });

  it("downloads a byte range", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    const result = await provider.download("/hello.txt", { range: { start: 0, end: 4 } });

    expect(result.status).toBe(206);
    const text = await new Response(result.body).text();
    expect(text).toBe("hello");
  });

  it("forwards If-Range on a download", async () => {
    const server = createFakeSftpgoServer(ALICE_SEED);
    const calls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init) {
        calls.push(init);
      }
      return server.fetch(input, init);
    };
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: fetchImpl });
    const token = await client.login({ username: "alice", password: "secret" });
    const withToken: WithToken = async (fn) => fn(token.accessToken);
    const provider = createSftpgoStorageProvider({ client, withToken });

    const downloadOpts: SftpgoDownloadOpts = { ifRange: "some-etag" };
    await provider.download("/hello.txt", downloadOpts);

    const downloadCall = calls.find((c) => new Headers(c.headers).has("if-range"));
    expect(downloadCall).toBeDefined();
    expect(new Headers(downloadCall?.headers).get("if-range")).toBe("some-etag");
  });

  it("passes an AbortSignal through to a download", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    const controller = new AbortController();
    const result = await provider.download("/hello.txt", { signal: controller.signal });

    expect(result.status).toBe(200);
  });

  it("uploads a file", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    await provider.upload("/new.txt", new TextEncoder().encode("data"), {
      mkdirParents: true,
      modifiedAt: new Date("2024-01-01T00:00:00.000Z"),
      contentLength: 4,
    });

    const stat = await provider.statFile("/new.txt");
    expect(stat.size).toBe(4);
  });

  it("passes an AbortSignal through to an upload", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    const controller = new AbortController();
    await provider.upload("/signal.txt", new TextEncoder().encode("data"), {
      signal: controller.signal,
    });

    const stat = await provider.statFile("/signal.txt");
    expect(stat.size).toBe(4);
  });

  it("creates a directory", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    await provider.mkdir("/newdir", { parents: true });

    const entries = await provider.list("/");
    expect(entries.map((e) => e.name)).toContain("newdir");
  });

  it("moves a file", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    await provider.move("/hello.txt", "/moved.txt");

    const entries = await provider.list("/");
    expect(entries.map((e) => e.name)).toEqual(["moved.txt"]);
  });

  it("copies a file", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    await provider.copy("/hello.txt", "/copy.txt");

    const entries = await provider.list("/");
    expect(entries.map((e) => e.name).sort()).toEqual(["copy.txt", "hello.txt"]);
  });

  it("deletes a file", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    await provider.deleteFile("/hello.txt");

    const entries = await provider.list("/");
    expect(entries).toEqual([]);
  });

  it("deletes a directory", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    await provider.mkdir("/dir");
    await provider.deleteDir("/dir");

    const entries = await provider.list("/");
    expect(entries.map((e) => e.name)).toEqual(["hello.txt"]);
  });

  it("sets a file's modified time", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    await provider.setModifiedAt("/hello.txt", new Date("2020-01-01T00:00:00.000Z"));

    const stat = await provider.statFile("/hello.txt");
    expect(stat.modifiedAt?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("zips paths", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    const stream = await provider.zip(["/hello.txt"]);
    const bytes = await new Response(stream).arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});

describe("createSftpgoStorageProvider - forbidden mapping (bob has no access)", () => {
  it("maps a 403 from SFTPGo to a forbidden StorageError", async () => {
    const seed: FakeSeed = {
      users: [
        { username: "alice", password: "secret", permissions: { "/": FULL_PERMS } },
        { username: "bob", password: "secret2", permissions: { "/": [] } },
      ],
      files: { alice: { "/hello.txt": "hello world" } },
    };
    const { client } = setup(seed);
    const withToken = await withTokenFor(client, "bob", "secret2");
    const provider = createSftpgoStorageProvider({ client, withToken });

    await expect(provider.list("/")).rejects.toMatchObject({ kind: "forbidden" });
  });
});

describe("createSftpgoStorageProvider - not_found mapping", () => {
  it("maps a 404 from SFTPGo to a not_found StorageError", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    await expect(provider.statFile("/missing.txt")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("preserves the upstream detail string in details", async () => {
    const { client } = setup(ALICE_SEED);
    const withToken = await withTokenFor(client, "alice", "secret");
    const provider = createSftpgoStorageProvider({ client, withToken });

    try {
      await provider.statFile("/missing.txt");
      expect.unreachable("expected statFile to throw");
    } catch (error) {
      expect(isStorageError(error)).toBe(true);
      if (isStorageError(error)) {
        expect(error.details?.detail).toBeTruthy();
      }
    }
  });
});

describe("createSftpgoStorageProvider - error kind mapping", () => {
  function errorFetchClient(status: number, body: unknown = { message: "boom" }) {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    return createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: fetchImpl });
  }

  const withToken: WithToken = async (fn) => fn("token");

  const cases: Array<{ status: number; expected: StorageErrorKind }> = [
    { status: 400, expected: "bad_request" },
    { status: 401, expected: "unauthorized" },
    { status: 403, expected: "forbidden" },
    { status: 404, expected: "not_found" },
    { status: 409, expected: "conflict" },
    { status: 413, expected: "payload_too_large" },
    { status: 429, expected: "rate_limited" },
    { status: 500, expected: "upstream_unavailable" },
    { status: 418, expected: "internal" },
  ];

  for (const { status, expected } of cases) {
    it(`maps HTTP ${status} to StorageError kind "${expected}"`, async () => {
      const client = errorFetchClient(status);
      const provider = createSftpgoStorageProvider({ client, withToken });

      await expect(provider.list("/")).rejects.toMatchObject({ kind: expected });
    });
  }

  it("maps a network failure to upstream_unavailable", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("connection refused");
    };
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: fetchImpl });
    const provider = createSftpgoStorageProvider({ client, withToken });

    await expect(provider.list("/")).rejects.toMatchObject({ kind: "upstream_unavailable" });
  });

  it("rethrows an error that is not a SftpgoError", async () => {
    const boom = new Error("not a sftpgo error");
    const throwingWithToken: WithToken = async () => {
      throw boom;
    };
    const client = errorFetchClient(500);
    const provider = createSftpgoStorageProvider({ client, withToken: throwingWithToken });

    await expect(provider.list("/")).rejects.toBe(boom);
  });

  it("omits details when the upstream error has no detail text", async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: fetchImpl });
    const provider = createSftpgoStorageProvider({ client, withToken });

    try {
      await provider.list("/");
      expect.unreachable("expected list to throw");
    } catch (error) {
      expect(isStorageError(error)).toBe(true);
      if (isStorageError(error)) {
        expect(error.details).toBeUndefined();
      }
    }
  });
});
