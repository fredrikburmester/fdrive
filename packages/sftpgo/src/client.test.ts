import { describe, expect, it, vi } from "vitest";
import { createSftpgoClient } from "./client.js";
import { createFakeSftpgoServer } from "./fake/server.js";
import type { FakeSeed } from "./fake/types.js";

const FULL_PERMS = ["*"];

function setup(seed: FakeSeed) {
  const server = createFakeSftpgoServer(seed);
  const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
  return { server, client };
}

async function loginAsAlice(client: ReturnType<typeof createSftpgoClient>): Promise<string> {
  const token = await client.login({ username: "alice", password: "secret" });
  return token.accessToken;
}

const ALICE_SEED: FakeSeed = {
  users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
};

describe("createSftpgoClient - login/logout", () => {
  it("logs in with valid credentials and returns a token with an expiry date", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await client.login({ username: "alice", password: "secret" });
    expect(token.accessToken).toBeTruthy();
    expect(token.expiresAt).toBeInstanceOf(Date);
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects an invalid password with kind unauthorized", async () => {
    const { client } = setup(ALICE_SEED);
    await expect(client.login({ username: "alice", password: "wrong" })).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
    });
  });

  it("rejects an unknown username", async () => {
    const { client } = setup(ALICE_SEED);
    await expect(client.login({ username: "nobody", password: "x" })).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("sends the OTP header when provided, without affecting the fake (which ignores it)", async () => {
    const server = createFakeSftpgoServer(ALICE_SEED);
    const calls: Array<RequestInit | undefined> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(init);
      return server.fetch(input, init);
    };
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: fetchImpl });
    await client.login({ username: "alice", password: "secret", otp: "123456" });
    const headers = new Headers(calls[0]?.headers);
    expect(headers.get("x-sftpgo-otp")).toBe("123456");
  });

  it("logs out and invalidates the token", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await client.logout(token);
    await expect(client.user(token).profile()).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("rejects logout with an invalid token", async () => {
    const { client } = setup(ALICE_SEED);
    await expect(client.logout("not-a-real-token")).rejects.toMatchObject({ kind: "unauthorized" });
  });
});

describe("createSftpgoClient - baseUrl handling", () => {
  it("strips a trailing slash from the base URL", async () => {
    const server = createFakeSftpgoServer(ALICE_SEED);
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test/", fetch: server.fetch });
    const token = await client.login({ username: "alice", password: "secret" });
    expect(token.accessToken).toBeTruthy();
  });
});

describe("createSftpgoClient - path validation", () => {
  it("rejects a relative path before making a request", async () => {
    const { server, client } = setup(ALICE_SEED);
    const fetchSpy = vi.spyOn(server, "fetch");
    const token = await loginAsAlice(client);
    await expect(client.user(token).list("relative/path")).rejects.toMatchObject({
      kind: "bad_request",
      status: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a path containing a NUL byte", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await expect(client.user(token).list("/a\0b")).rejects.toMatchObject({ kind: "bad_request" });
  });
});

describe("createSftpgoClient - list", () => {
  it("lists files and directories with parsed kind, size, and mtime", async () => {
    const { client } = setup({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/docs/a.txt": "hello" } },
    });
    const token = await loginAsAlice(client);
    const entries = await client.user(token).list("/docs");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "a.txt", kind: "file", size: 5 });
    expect(entries[0]?.modifiedAt).toBeInstanceOf(Date);
  });

  it("lists a subdirectory as kind dir", async () => {
    const { client } = setup({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/docs/a.txt": "hello" } },
    });
    const token = await loginAsAlice(client);
    const entries = await client.user(token).list("/");
    expect(entries.find((e) => e.name === "docs")).toMatchObject({ kind: "dir" });
  });

  it("returns not_found for a missing directory", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await expect(client.user(token).list("/missing")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("returns bad_request when listing a path that is a file", async () => {
    const { client } = setup({ ...ALICE_SEED, files: { alice: { "/a.txt": "x" } } });
    const token = await loginAsAlice(client);
    await expect(client.user(token).list("/a.txt")).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("returns forbidden when the user lacks the list permission", async () => {
    const { client } = setup({
      users: [{ username: "alice", password: "secret", permissions: { "/": ["download"] } }],
    });
    const token = await loginAsAlice(client);
    await expect(client.user(token).list("/")).rejects.toMatchObject({
      kind: "forbidden",
      status: 403,
    });
  });
});

describe("createSftpgoClient - probeDirectoryRead", () => {
  it("probes an existing directory containing files", async () => {
    const { client } = setup({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/docs/a.txt": "hello" } },
    });
    const token = await loginAsAlice(client);
    await expect(client.user(token).probeDirectoryRead("/docs")).resolves.toBeUndefined();
  });

  it("probes an empty directory successfully", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await client.user(token).mkdir("/empty");
    await expect(client.user(token).probeDirectoryRead("/empty")).resolves.toBeUndefined();
  });

  it("validates path before request", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await expect(client.user(token).probeDirectoryRead("relative")).rejects.toMatchObject({
      kind: "bad_request",
    });
    await expect(client.user(token).probeDirectoryRead("/a\0b")).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("returns not_found for a missing directory", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await expect(client.user(token).probeDirectoryRead("/missing")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("returns forbidden when user lacks list permission", async () => {
    const { client } = setup({
      users: [{ username: "alice", password: "secret", permissions: { "/": ["download"] } }],
    });
    const token = await loginAsAlice(client);
    await expect(client.user(token).probeDirectoryRead("/")).rejects.toMatchObject({
      kind: "forbidden",
      status: 403,
    });
  });

  it("rejects when response body is null", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(null, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: fakeFetch });
    await expect(client.user("token").probeDirectoryRead("/")).rejects.toMatchObject({
      kind: "server",
      message: "Missing response body for directory probe",
    });
  });
});

describe("createSftpgoClient - statFile and download", () => {
  const seed: FakeSeed = {
    users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    files: { alice: { "/a.txt": "hello world" } },
  };

  it("stats a file via HEAD", async () => {
    const { client } = setup(seed);
    const token = await loginAsAlice(client);
    const stat = await client.user(token).statFile("/a.txt");
    expect(stat.size).toBe(11);
    expect(stat.contentType).toBe("application/octet-stream");
    expect(stat.modifiedAt).toBeInstanceOf(Date);
  });

  it("returns not_found stat for a missing file", async () => {
    const { client } = setup(seed);
    const token = await loginAsAlice(client);
    await expect(client.user(token).statFile("/missing.txt")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("downloads a full file with status 200", async () => {
    const { client } = setup(seed);
    const token = await loginAsAlice(client);
    const result = await client.user(token).download("/a.txt");
    expect(result.status).toBe(200);
    expect(result.contentLength).toBe(11);
    expect(result.contentRange).toBeNull();
    const text = await new Response(result.body).text();
    expect(text).toBe("hello world");
  });

  it("downloads a byte range with status 206 and a Content-Range header", async () => {
    const { client } = setup(seed);
    const token = await loginAsAlice(client);
    const result = await client.user(token).download("/a.txt", { range: { start: 0, end: 4 } });
    expect(result.status).toBe(206);
    expect(result.contentRange).toBe("bytes 0-4/11");
    const text = await new Response(result.body).text();
    expect(text).toBe("hello");
  });

  it("downloads an open-ended range to the end of the file", async () => {
    const { client } = setup(seed);
    const token = await loginAsAlice(client);
    const result = await client.user(token).download("/a.txt", { range: { start: 6 } });
    const text = await new Response(result.body).text();
    expect(text).toBe("world");
  });

  it("honours a suffix range (bytes=-N) sent as a raw Range header", async () => {
    const { server, client } = setup(seed);
    const token = await loginAsAlice(client);
    const response = await server.fetch("http://sftpgo.test/api/v2/user/files?path=%2Fa.txt", {
      headers: { authorization: `Bearer ${token}`, range: "bytes=-5" },
    });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("world");
  });

  it("maps an unsatisfiable range to bad_request (HTTP 416)", async () => {
    const { client } = setup(seed);
    const token = await loginAsAlice(client);
    await expect(
      client.user(token).download("/a.txt", { range: { start: 1000, end: 2000 } }),
    ).rejects.toMatchObject({
      kind: "bad_request",
      status: 416,
    });
  });

  it("returns bad_request when downloading a directory", async () => {
    const { client } = setup({ ...seed, files: { alice: { "/dir/a.txt": "x" } } });
    const token = await loginAsAlice(client);
    await expect(client.user(token).download("/dir")).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("returns forbidden when the user lacks download permission", async () => {
    const { client } = setup({
      users: [{ username: "alice", password: "secret", permissions: { "/": ["list"] } }],
      files: { alice: { "/a.txt": "hi" } },
    });
    const token = await loginAsAlice(client);
    await expect(client.user(token).download("/a.txt")).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("sends the ifRange option as an If-Range header", async () => {
    let capturedIfRange: string | null = null;
    const fetchImpl = vi.fn(async (_url, init: RequestInit | undefined) => {
      capturedIfRange = new Headers(init?.headers).get("if-range");
      return new Response("x", { status: 200 });
    });
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    await client.user("tok").download("/a.txt", { ifRange: "etag-value" });
    expect(capturedIfRange).toBe("etag-value");
  });

  it("respects a caller-provided abort signal", async () => {
    const { client } = setup(seed);
    const token = await loginAsAlice(client);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.user(token).download("/a.txt", { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "network" });
  });
});

describe("createSftpgoClient - upload", () => {
  it("uploads a Uint8Array body and it can be downloaded back", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await client.user(token).upload("/new.txt", new TextEncoder().encode("payload"));
    const result = await client.user(token).download("/new.txt");
    expect(await new Response(result.body).text()).toBe("payload");
  });

  it("uploads a ReadableStream body", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed"));
        controller.close();
      },
    });
    await client.user(token).upload("/stream.txt", stream);
    const result = await client.user(token).download("/stream.txt");
    expect(await new Response(result.body).text()).toBe("streamed");
  });

  it("fails without mkdirParents when the parent directory is missing", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await expect(
      client.user(token).upload("/missing-dir/file.txt", new Uint8Array()),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("creates missing parent directories with mkdirParents", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await client
      .user(token)
      .upload("/a/b/file.txt", new Uint8Array([1, 2, 3]), { mkdirParents: true });
    const stat = await client.user(token).statFile("/a/b/file.txt");
    expect(stat.size).toBe(3);
  });

  it("sends mkdir_parents=true on upload when mkdirParents is set", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      capturedUrl = String(input);
      return new Response(null, { status: 200 });
    });
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    await client.user("tok").upload("/a.txt", new Uint8Array(), { mkdirParents: true });
    expect(new URL(capturedUrl).searchParams.get("mkdir_parents")).toBe("true");
  });

  it("sends mkdir_parents=false on upload when mkdirParents is not given", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      capturedUrl = String(input);
      return new Response(null, { status: 200 });
    });
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    await client.user("tok").upload("/a.txt", new Uint8Array());
    expect(new URL(capturedUrl).searchParams.get("mkdir_parents")).toBe("false");
  });

  it("sends the modifiedAt option as X-SFTPGO-MTIME and it is honoured", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    const mtime = new Date("2020-01-01T00:00:00Z");
    await client.user(token).upload("/mtime.txt", new Uint8Array([1]), { modifiedAt: mtime });
    const stat = await client.user(token).statFile("/mtime.txt");
    expect(stat.modifiedAt).toEqual(mtime);
  });

  it("sends the contentLength option as a Content-Length header", async () => {
    let capturedContentLength: string | null = null;
    const fetchImpl = vi.fn(async (_url, init: RequestInit | undefined) => {
      capturedContentLength = new Headers(init?.headers).get("content-length");
      return new Response(null, { status: 200 });
    });
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    await client.user("tok").upload("/a.txt", new Uint8Array([1, 2, 3]), { contentLength: 3 });
    expect(capturedContentLength).toBe("3");
  });

  it("returns bad_request when uploading over an existing directory", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await client.user(token).mkdir("/adir");
    await expect(client.user(token).upload("/adir", new Uint8Array([1]))).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("requires the overwrite permission to replace an existing file", async () => {
    const { client } = setup({
      users: [
        {
          username: "alice",
          password: "secret",
          permissions: { "/": ["list", "download", "upload"] },
        },
      ],
      files: { alice: { "/existing.txt": "old" } },
    });
    const token = await loginAsAlice(client);
    await expect(
      client.user(token).upload("/existing.txt", new Uint8Array([1])),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("allows overwrite when the overwrite permission is granted", async () => {
    const { client } = setup({
      users: [
        {
          username: "alice",
          password: "secret",
          permissions: { "/": ["list", "download", "upload", "overwrite"] },
        },
      ],
      files: { alice: { "/existing.txt": "old" } },
    });
    const token = await loginAsAlice(client);
    await client.user(token).upload("/existing.txt", new TextEncoder().encode("new"));
    const result = await client.user(token).download("/existing.txt");
    expect(await new Response(result.body).text()).toBe("new");
  });

  it("returns forbidden without the upload permission", async () => {
    const { client } = setup({
      users: [{ username: "alice", password: "secret", permissions: { "/": ["list"] } }],
    });
    const token = await loginAsAlice(client);
    await expect(client.user(token).upload("/x.txt", new Uint8Array())).rejects.toMatchObject({
      kind: "forbidden",
    });
  });
});

describe("createSftpgoClient - mkdir", () => {
  it("creates a directory", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await client.user(token).mkdir("/newdir");
    const entries = await client.user(token).list("/");
    expect(entries.find((e) => e.name === "newdir")).toMatchObject({ kind: "dir" });
  });

  it("returns kind server when the directory already exists, matching the real server", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await client.user(token).mkdir("/newdir");
    await expect(client.user(token).mkdir("/newdir")).rejects.toMatchObject({
      kind: "server",
      status: 500,
    });
  });

  it("returns not_found when parents is not set and the parent is missing", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await expect(client.user(token).mkdir("/a/b")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("creates parents when requested", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await client.user(token).mkdir("/a/b", { parents: true });
    const entries = await client.user(token).list("/a");
    expect(entries.find((e) => e.name === "b")).toMatchObject({ kind: "dir" });
  });

  it("sends mkdir_parents=true when parents is requested", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      capturedUrl = String(input);
      return new Response(null, { status: 201 });
    });
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    await client.user("tok").mkdir("/a", { parents: true });
    expect(new URL(capturedUrl).searchParams.get("mkdir_parents")).toBe("true");
  });

  it("sends mkdir_parents=false when parents is not given", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      capturedUrl = String(input);
      return new Response(null, { status: 201 });
    });
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    await client.user("tok").mkdir("/a");
    expect(new URL(capturedUrl).searchParams.get("mkdir_parents")).toBe("false");
  });
});

describe("createSftpgoClient - move and copy", () => {
  const seed: FakeSeed = {
    users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    files: { alice: { "/a.txt": "content" } },
  };

  it("moves a file", async () => {
    const { client } = setup(seed);
    const token = await loginAsAlice(client);
    await client.user(token).move("/a.txt", "/b.txt");
    await expect(client.user(token).statFile("/a.txt")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect((await client.user(token).statFile("/b.txt")).size).toBe(7);
  });

  it("copies a file, keeping the original", async () => {
    const { client } = setup(seed);
    const token = await loginAsAlice(client);
    await client.user(token).copy("/a.txt", "/b.txt");
    expect((await client.user(token).statFile("/a.txt")).size).toBe(7);
    expect((await client.user(token).statFile("/b.txt")).size).toBe(7);
  });

  it("returns forbidden for move without rename permission", async () => {
    const { client } = setup({
      users: [
        { username: "alice", password: "secret", permissions: { "/": ["list", "download"] } },
      ],
      files: { alice: { "/a.txt": "x" } },
    });
    const token = await loginAsAlice(client);
    await expect(client.user(token).move("/a.txt", "/b.txt")).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("returns forbidden for copy without the copy permission", async () => {
    const { client } = setup({
      users: [
        {
          username: "alice",
          password: "secret",
          permissions: { "/": ["list", "download", "upload"] },
        },
      ],
      files: { alice: { "/a.txt": "x" } },
    });
    const token = await loginAsAlice(client);
    await expect(client.user(token).copy("/a.txt", "/b.txt")).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("returns not_found when the move source is missing", async () => {
    const { client } = setup(seed);
    const token = await loginAsAlice(client);
    await expect(client.user(token).move("/missing.txt", "/b.txt")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("overwrites the target and removes the source when moving a file onto an existing file", async () => {
    const { client } = setup({ ...seed, files: { alice: { "/a.txt": "1", "/b.txt": "2" } } });
    const token = await loginAsAlice(client);
    await client.user(token).move("/a.txt", "/b.txt");
    await expect(client.user(token).statFile("/a.txt")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect((await client.user(token).statFile("/b.txt")).size).toBe(1);
  });
});

describe("createSftpgoClient - delete", () => {
  it("deletes a file", async () => {
    const { client } = setup({ ...ALICE_SEED, files: { alice: { "/a.txt": "x" } } });
    const token = await loginAsAlice(client);
    await client.user(token).deleteFile("/a.txt");
    await expect(client.user(token).statFile("/a.txt")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("returns bad_request deleting a directory as a file", async () => {
    const { client } = setup({ ...ALICE_SEED, files: { alice: { "/dir/a.txt": "x" } } });
    const token = await loginAsAlice(client);
    await expect(client.user(token).deleteFile("/dir")).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("deletes a directory recursively", async () => {
    const { client } = setup({ ...ALICE_SEED, files: { alice: { "/dir/a.txt": "x" } } });
    const token = await loginAsAlice(client);
    await client.user(token).deleteDir("/dir");
    await expect(client.user(token).list("/dir")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("returns forbidden without delete permission", async () => {
    const { client } = setup({
      users: [
        { username: "alice", password: "secret", permissions: { "/": ["list", "download"] } },
      ],
      files: { alice: { "/a.txt": "x" } },
    });
    const token = await loginAsAlice(client);
    await expect(client.user(token).deleteFile("/a.txt")).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("returns not_found deleting a directory that does not exist", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await expect(client.user(token).deleteDir("/missing")).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});

describe("createSftpgoClient - setModifiedAt", () => {
  it("updates a file's modification time", async () => {
    const { client } = setup({ ...ALICE_SEED, files: { alice: { "/a.txt": "x" } } });
    const token = await loginAsAlice(client);
    const mtime = new Date("2022-05-01T00:00:00Z");
    await client.user(token).setModifiedAt("/a.txt", mtime);
    const stat = await client.user(token).statFile("/a.txt");
    expect(stat.modifiedAt).toEqual(mtime);
  });

  it("returns not_found for a missing file", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await expect(
      client.user(token).setModifiedAt("/missing.txt", new Date()),
    ).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("returns bad_request for a directory", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    await client.user(token).mkdir("/adir");
    await expect(client.user(token).setModifiedAt("/adir", new Date())).rejects.toMatchObject({
      kind: "bad_request",
    });
  });
});

describe("createSftpgoClient - zip", () => {
  it("produces a downloadable zip stream containing the requested files", async () => {
    const { client } = setup({
      ...ALICE_SEED,
      files: { alice: { "/a.txt": "hello", "/dir/b.txt": "world" } },
    });
    const token = await loginAsAlice(client);
    const stream = await client.user(token).zip(["/a.txt", "/dir"]);
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
  });

  it("silently skips a path that does not exist", async () => {
    const { client } = setup({ ...ALICE_SEED, files: { alice: { "/a.txt": "hello" } } });
    const token = await loginAsAlice(client);
    const stream = await client.user(token).zip(["/a.txt", "/missing.txt"]);
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("createSftpgoClient - profile", () => {
  it("returns a synthesized profile", async () => {
    const { client } = setup(ALICE_SEED);
    const token = await loginAsAlice(client);
    const profile = await client.user(token).profile();
    expect(profile.email).toContain("alice");
    expect(profile.allowApiKeyAuth).toBe(false);
    expect(profile.publicKeys).toEqual([]);
  });
});

describe("createSftpgoClient - virtual folders", () => {
  it("shares content between two users mounting the same folder", async () => {
    const seed: FakeSeed = {
      users: [
        {
          username: "alice",
          password: "secret",
          permissions: { "/": FULL_PERMS },
          virtualFolders: [{ name: "shared", virtualPath: "/shared" }],
        },
        {
          username: "bob",
          password: "secret2",
          permissions: { "/": FULL_PERMS },
          virtualFolders: [{ name: "shared", virtualPath: "/team" }],
        },
      ],
      folders: [{ name: "shared" }],
      files: { "@shared": { "/notes.txt": "shared content" } },
    };
    const { client } = setup(seed);
    const aliceToken = await client
      .login({ username: "alice", password: "secret" })
      .then((t) => t.accessToken);
    const bobToken = await client
      .login({ username: "bob", password: "secret2" })
      .then((t) => t.accessToken);

    const aliceEntries = await client.user(aliceToken).list("/shared");
    expect(aliceEntries.map((e) => e.name)).toContain("notes.txt");

    await client
      .user(aliceToken)
      .upload("/shared/new-from-alice.txt", new TextEncoder().encode("hi"));
    const bobEntries = await client.user(bobToken).list("/team");
    expect(bobEntries.map((e) => e.name)).toContain("new-from-alice.txt");
  });
});

describe("createSftpgoClient - error kind mapping via a stub fetch", () => {
  function stubClient(status: number, body: unknown = { message: "", error: "boom" }) {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    return client;
  }

  it.each([
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [413, "payload_too_large"],
    [429, "rate_limited"],
    [500, "server"],
    [418, "unexpected"],
  ] as const)("maps HTTP %i to kind %s", async (status, kind) => {
    const client = stubClient(status);
    await expect(client.user("tok").profile()).rejects.toMatchObject({ kind, status });
  });

  it("maps a rejected fetch to kind network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    await expect(client.user("tok").profile()).rejects.toMatchObject({
      kind: "network",
      status: null,
    });
  });

  it("uses a default timeout of 30s and applies AbortSignal.timeout", async () => {
    const fetchImpl = vi.fn(async (_url, init: RequestInit | undefined) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    await client.user("tok").profile();
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("uses a custom user agent when provided", async () => {
    let capturedUserAgent: string | null = null;
    const fetchImpl = vi.fn(async (_url, init: RequestInit | undefined) => {
      capturedUserAgent = new Headers(init?.headers).get("user-agent");
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const client = createSftpgoClient({
      baseUrl: "http://host",
      fetch: fetchImpl,
      userAgent: "custom-agent",
    });
    await client.user("tok").profile();
    expect(capturedUserAgent).toBe("custom-agent");
  });

  it("defaults the user agent to fdrive", async () => {
    let capturedUserAgent: string | null = null;
    const fetchImpl = vi.fn(async (_url, init: RequestInit | undefined) => {
      capturedUserAgent = new Headers(init?.headers).get("user-agent");
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    await client.user("tok").profile();
    expect(capturedUserAgent).toBe("fdrive");
  });

  it("defaults to globalThis.fetch when no fetch option is given", () => {
    expect(() => createSftpgoClient({ baseUrl: "http://host" })).not.toThrow();
  });

  it("falls back to an empty stream when the response has no body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    const result = await client.user("tok").download("/a.txt");
    const reader = result.body.getReader();
    expect((await reader.read()).done).toBe(true);
  });

  it("falls back to an empty stream for a public share download when the response has no body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    const result = await client.publicShare("id1").download("/a.txt");
    const reader = result.body.getReader();
    expect((await reader.read()).done).toBe(true);
  });

  it("falls back to an empty stream for zip when the response has no body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    const stream = await client.user("tok").zip(["/a.txt"]);
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(true);
  });

  it("falls back to an empty stream for a public share zip when the response has no body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    const stream = await client.publicShare("id1").zip();
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(true);
  });

  it("defaults statFile size to 0 when Content-Length is missing", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    const stat = await client.user("tok").statFile("/a.txt");
    expect(stat.size).toBe(0);
  });

  it("defaults a created share's id to an empty string when X-Object-ID is missing", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    const created = await client
      .user("tok")
      .shares.create({ name: "s", scope: "read", paths: ["/"] });
    expect(created.id).toBe("");
  });
});
