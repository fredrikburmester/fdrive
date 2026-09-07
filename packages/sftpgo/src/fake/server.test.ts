import { describe, expect, it } from "vitest";
import { parseZipCentralDirectory } from "../../test/contract/zip-parser.js";
import { createSftpgoClient } from "../client.js";
import { createFakeSftpgoServer } from "./server.js";
import type { FakeSeed } from "./types.js";

const FULL_PERMS = ["*"];

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe("fake server - routing edge cases", () => {
  it("returns 404 for a route outside the known API surface", async () => {
    const server = createFakeSftpgoServer({ users: [] });
    const response = await server.fetch("http://sftpgo.test/api/v2/other", { method: "GET" });
    expect(response.status).toBe(404);
  });

  it("returns 401 for a protected route with no Authorization header", async () => {
    const server = createFakeSftpgoServer({ users: [] });
    const response = await server.fetch("http://sftpgo.test/api/v2/user/profile");
    expect(response.status).toBe(401);
  });

  it("returns 401 for a malformed Authorization header on login", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: {} }],
    });
    const response = await server.fetch("http://sftpgo.test/api/v2/user/token", {
      headers: { authorization: "Bearer not-basic" },
    });
    expect(response.status).toBe(401);
  });

  it("returns 401 for a Basic header with no colon separator", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: {} }],
    });
    const response = await server.fetch("http://sftpgo.test/api/v2/user/token", {
      headers: { authorization: `Basic ${Buffer.from("no-colon-here").toString("base64")}` },
    });
    expect(response.status).toBe(401);
  });

  it("expires a token after its ttl", async () => {
    let now = new Date("2024-01-01T00:00:00Z");
    const seed: FakeSeed = {
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      tokenTtlMs: 1000,
      now: () => now,
    };
    const server = createFakeSftpgoServer(seed);
    const loginResponse = await server.fetch("http://sftpgo.test/api/v2/user/token", {
      headers: { authorization: basicAuth("alice", "secret") },
    });
    const { access_token: token } = (await loginResponse.json()) as { access_token: string };

    now = new Date(now.getTime() + 2000);
    const profileResponse = await server.fetch("http://sftpgo.test/api/v2/user/profile", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(profileResponse.status).toBe(401);
  });

  it("rejects a PATCH metadata request with an invalid body", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/a.txt": "hi" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;

    const badJson = await server.fetch(
      "http://sftpgo.test/api/v2/user/files/metadata?path=%2Fa.txt",
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}` },
        body: "not json",
      },
    );
    expect(badJson.status).toBe(400);

    const missingField = await server.fetch(
      "http://sftpgo.test/api/v2/user/files/metadata?path=%2Fa.txt",
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      },
    );
    expect(missingField.status).toBe(400);
  });

  it("rejects a streamzip request with an invalid body", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;

    const notArray = await server.fetch("http://sftpgo.test/api/v2/user/streamzip", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ not: "an array" }),
    });
    expect(notArray.status).toBe(400);

    const invalidPath = await server.fetch("http://sftpgo.test/api/v2/user/streamzip", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(["relative/path"]),
    });
    expect(invalidPath.status).toBe(400);
  });

  it("rejects move and copy across two different virtual folder mounts", async () => {
    const server = createFakeSftpgoServer({
      users: [
        {
          username: "alice",
          password: "secret",
          permissions: { "/": FULL_PERMS },
          virtualFolders: [
            { name: "one", virtualPath: "/one" },
            { name: "two", virtualPath: "/two" },
          ],
        },
      ],
      folders: [{ name: "one" }, { name: "two" }],
      files: { "@one": { "/a.txt": "x" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;

    await expect(client.user(token).move("/one/a.txt", "/two/a.txt")).rejects.toMatchObject({
      kind: "bad_request",
    });
    await expect(client.user(token).copy("/one/a.txt", "/two/a.txt")).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("returns bad_request deleting a file path with deleteDir", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/a.txt": "x" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    await expect(client.user(token).deleteDir("/a.txt")).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("returns forbidden when stat lacks the download permission", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": ["list"] } }],
      files: { alice: { "/a.txt": "x" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    await expect(client.user(token).statFile("/a.txt")).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("rejects an unsupported method on a share item route", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/"] });
    const response = await server.fetch(`http://sftpgo.test/api/v2/user/shares/${created.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });

  it("cannot get, update, or remove another user's share", async () => {
    const server = createFakeSftpgoServer({
      users: [
        { username: "alice", password: "secret", permissions: { "/": FULL_PERMS } },
        { username: "bob", password: "secret2", permissions: { "/": FULL_PERMS } },
      ],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const aliceToken = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const bobToken = (await client.login({ username: "bob", password: "secret2" })).accessToken;
    const created = await client
      .user(aliceToken)
      .shares.create({ name: "s", scope: "read", paths: ["/"] });

    await expect(client.user(bobToken).shares.get(created.id)).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(
      client.user(bobToken).shares.update(created.id, { name: "x", scope: "read", paths: ["/"] }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(client.user(bobToken).shares.remove(created.id)).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("rejects a public upload with a file name containing a slash", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/shared/existing.txt": "x" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "write", paths: ["/shared"] });
    await expect(
      client.publicShare(created.id).upload("nested/evil.txt", new Uint8Array([1])),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("rejects direct child downloads for multi-path shares", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/a.txt": "aaa", "/b.txt": "bbb" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client.user(token).shares.create({
      name: "s",
      scope: "read",
      paths: ["/a.txt", "/b.txt"],
    });
    for (const path of ["/b.txt", "/c.txt"])
      await expect(client.publicShare(created.id).download(path)).rejects.toMatchObject({
        kind: "bad_request",
      });
  });

  it("rejects uploading to a write share whose single path is a file, not a directory", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/a.txt": "x" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "write", paths: ["/a.txt"] });
    await expect(
      client.publicShare(created.id).upload("x.txt", new Uint8Array([1])),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("returns 401 for a bearer token whose user has since been removed", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    server.state.users.delete("alice");
    await expect(client.user(token).profile()).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("treats a multi-range Range header as unsatisfiable", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/a.txt": "hello world" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const response = await server.fetch("http://sftpgo.test/api/v2/user/files?path=%2Fa.txt", {
      headers: { authorization: `Bearer ${token}`, range: "bytes=0-1,3-4" },
    });
    expect(response.status).toBe(416);
  });

  it("treats an empty Range header value as unsatisfiable", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/a.txt": "hello world" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const response = await server.fetch("http://sftpgo.test/api/v2/user/files?path=%2Fa.txt", {
      headers: { authorization: `Bearer ${token}`, range: "bytes=-" },
    });
    expect(response.status).toBe(416);
  });

  it("treats a zero-length suffix range as unsatisfiable", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/a.txt": "hello world" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const response = await server.fetch("http://sftpgo.test/api/v2/user/files?path=%2Fa.txt", {
      headers: { authorization: `Bearer ${token}`, range: "bytes=-0" },
    });
    expect(response.status).toBe(416);
  });

  it("rejects move and copy requests with an invalid path or target", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/a.txt": "x" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const response = await server.fetch(
      "http://sftpgo.test/api/v2/user/file-actions/move?path=relative&target=%2Fb.txt",
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(400);
  });

  it("rejects a share create request with an invalid JSON body", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const response = await server.fetch("http://sftpgo.test/api/v2/user/shares", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  it("rejects a share update request with an invalid JSON body", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/"] });
    const response = await server.fetch(`http://sftpgo.test/api/v2/user/shares/${created.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  it("rejects an unsupported method on the shares collection route", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const response = await server.fetch("http://sftpgo.test/api/v2/user/shares", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });

  it("returns 404 for a bare share id request that does not ask to compress", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/"] });
    const response = await server.fetch(`http://sftpgo.test/api/v2/shares/${created.id}`);
    expect(response.status).toBe(404);
  });

  it("returns 404 for an unknown share sub-route", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/"] });
    const response = await server.fetch(`http://sftpgo.test/api/v2/shares/${created.id}/unknown`);
    expect(response.status).toBe(404);
  });

  it("rejects public dirs/files requests with an invalid path parameter", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/shared/a.txt": "hi" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/shared"] });

    const listResponse = await server.fetch(
      `http://sftpgo.test/api/v2/shares/${created.id}/dirs?path=relative`,
    );
    expect(listResponse.status).toBe(400);

    const downloadResponse = await server.fetch(
      `http://sftpgo.test/api/v2/shares/${created.id}/files?path=relative`,
    );
    expect(downloadResponse.status).toBe(400);
  });

  it("returns not_found when listing a subpath that does not exist within the share", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/shared/a.txt": "hi" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/shared"] });
    await expect(client.publicShare(created.id).list("/does-not-exist")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("propagates the password check from download, zip, and upload", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/shared/a.txt": "hi" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client.user(token).shares.create({
      name: "s",
      scope: "write",
      paths: ["/shared"],
      password: "letmein",
    });

    await expect(client.publicShare(created.id).download("/a.txt")).rejects.toMatchObject({
      kind: "forbidden",
    });
    await expect(client.publicShare(created.id).zip()).rejects.toMatchObject({
      kind: "forbidden",
    });
    await expect(
      client.publicShare(created.id).upload("x.txt", new Uint8Array([1])),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("returns not_found when a directory share's file does not exist and bad_request for a subdirectory", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/shared/nested/a.txt": "hi" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/shared"] });

    await expect(client.publicShare(created.id).download("/missing.txt")).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(client.publicShare(created.id).download("/nested")).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("returns bad_request when a single-path share has a malformed empty path entry", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/shared/a.txt": "hi" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/shared"] });
    const share = server.state.shares.get(created.id);
    expect(share).toBeDefined();
    if (share) {
      // Force the defensive invalid-root branch: a well-formed share can never
      // actually have an undefined entry in a length-1 paths array.
      share.paths = [undefined as unknown as string];
    }
    await expect(client.publicShare(created.id).download("/a.txt")).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("returns 400 for user filesystem endpoints called without a path parameter", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/a.txt": "hi" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const auth = { authorization: `Bearer ${token}` };

    const routes: Array<{ path: string; method: string }> = [
      { path: "/api/v2/user/dirs", method: "GET" },
      { path: "/api/v2/user/dirs", method: "POST" },
      { path: "/api/v2/user/dirs", method: "DELETE" },
      { path: "/api/v2/user/files", method: "HEAD" },
      { path: "/api/v2/user/files", method: "GET" },
      { path: "/api/v2/user/files", method: "DELETE" },
      { path: "/api/v2/user/files/upload", method: "POST" },
      { path: "/api/v2/user/files/metadata", method: "PATCH" },
    ];
    for (const route of routes) {
      const response = await server.fetch(`http://sftpgo.test${route.path}`, {
        method: route.method,
        headers: auth,
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(400);
    }
  });

  it("returns forbidden creating a directory or removing one without the matching permission", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": ["list"] } }],
      files: { alice: { "/dir/a.txt": "x" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    await expect(client.user(token).mkdir("/newdir")).rejects.toMatchObject({ kind: "forbidden" });
    await expect(client.user(token).deleteDir("/dir")).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("returns not_found deleting a file that does not exist", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    await expect(client.user(token).deleteFile("/missing.txt")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("rejects a streamzip request whose body is not valid JSON", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const response = await server.fetch("http://sftpgo.test/api/v2/user/streamzip", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  it("rejects a public upload whose file name collides with an existing subdirectory", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/shared/nested/a.txt": "hi" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "write", paths: ["/shared"] });
    await expect(
      client.publicShare(created.id).upload("nested", new Uint8Array([1])),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("falls back to the fake clock's current time when X-SFTPGO-MTIME is not a number", async () => {
    const fixed = new Date("2024-03-15T10:00:00Z");
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      now: () => fixed,
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const response = await server.fetch(
      "http://sftpgo.test/api/v2/user/files/upload?path=%2Fa.txt",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-sftpgo-mtime": "not-a-number" },
        body: new Uint8Array([1]),
      },
    );
    expect(response.status).toBe(200);
    const stat = await client.user(token).statFile("/a.txt");
    expect(stat.modifiedAt).toEqual(fixed);
  });

  it("moves a directory, requiring the rename_dirs (or rename) permission rather than rename_files", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/dir/a.txt": "x" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    await client.user(token).move("/dir", "/moved");
    const entries = await client.user(token).list("/moved");
    expect(entries.map((e) => e.name)).toEqual(["a.txt"]);
  });

  it("creates a share omitting every optional field, exercising the server's own defaults", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const createResponse = await server.fetch("http://sftpgo.test/api/v2/user/shares", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "bare", scope: 1, paths: ["/"] }),
    });
    expect(createResponse.status).toBe(201);
    const id = createResponse.headers.get("x-object-id");
    expect(id).toBeTruthy();

    const share = await client.user(token).shares.get(id ?? "");
    expect(share).toMatchObject({ description: "", maxTokens: 0, allowFrom: [], expiresAt: null });

    const updateResponse = await server.fetch(`http://sftpgo.test/api/v2/user/shares/${id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "bare2", scope: 1, paths: ["/"] }),
    });
    expect(updateResponse.status).toBe(200);
    const updated = await client.user(token).shares.get(id ?? "");
    expect(updated).toMatchObject({
      name: "bare2",
      description: "",
      maxTokens: 0,
      allowFrom: [],
      expiresAt: null,
    });
  });

  it("lists a public share whose single path is the user's own root", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/a.txt": "hi", "/docs/b.txt": "hi" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/"] });

    const defaultPathResponse = await server.fetch(
      `http://sftpgo.test/api/v2/shares/${created.id}/dirs`,
    );
    expect(defaultPathResponse.status).toBe(200);
    const rootEntries = (await defaultPathResponse.json()) as Array<{ name: string }>;
    expect(rootEntries.map((e) => e.name).sort()).toEqual(["a.txt", "docs"]);

    const nested = await client.publicShare(created.id).list("/docs");
    expect(nested.map((e) => e.name)).toEqual(["b.txt"]);

    const download = await client.publicShare(created.id).download("/docs/b.txt");
    expect(await new Response(download.body).text()).toBe("hi");
  });

  it("uploads into a write share whose single path is the user's own root", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "write", paths: ["/"] });
    await client.publicShare(created.id).upload("root-upload.txt", new TextEncoder().encode("hi"));
    const stat = await client.user(token).statFile("/root-upload.txt");
    expect(stat.size).toBe(2);
  });

  it("returns 404 for an unsupported method on the dirs and files routes", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const auth = { authorization: `Bearer ${token}` };

    const dirsResponse = await server.fetch("http://sftpgo.test/api/v2/user/dirs?path=%2F", {
      method: "PATCH",
      headers: auth,
    });
    expect(dirsResponse.status).toBe(404);

    const filesResponse = await server.fetch("http://sftpgo.test/api/v2/user/files?path=%2Fa.txt", {
      method: "PUT",
      headers: auth,
    });
    expect(filesResponse.status).toBe(404);
  });

  it("only accepts mkdir_parents=true, not the legacy 1/0 wire values, on mkdir", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const auth = { authorization: `Bearer ${token}` };

    const withLegacyOne = await server.fetch(
      "http://sftpgo.test/api/v2/user/dirs?path=%2Fa%2Fb&mkdir_parents=1",
      { method: "POST", headers: auth },
    );
    expect(withLegacyOne.status).toBe(404);

    const withTrue = await server.fetch(
      "http://sftpgo.test/api/v2/user/dirs?path=%2Fa%2Fb&mkdir_parents=true",
      { method: "POST", headers: auth },
    );
    expect(withTrue.status).toBe(201);
  });

  it("only accepts mkdir_parents=true, not the legacy 1/0 wire values, on upload", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const auth = { authorization: `Bearer ${token}` };

    const withLegacyOne = await server.fetch(
      "http://sftpgo.test/api/v2/user/files/upload?path=%2Fa%2Fb.txt&mkdir_parents=1",
      { method: "POST", headers: auth, body: new Uint8Array([1]) },
    );
    expect(withLegacyOne.status).toBe(404);

    const withTrue = await server.fetch(
      "http://sftpgo.test/api/v2/user/files/upload?path=%2Fa%2Fb.txt&mkdir_parents=true",
      { method: "POST", headers: auth, body: new Uint8Array([1]) },
    );
    expect(withTrue.status).toBe(200);
  });

  it("reports mkdir on an already-existing directory as a 500 with SFTPGo's error body shape", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    await client.user(token).mkdir("/newdir");

    const response = await server.fetch("http://sftpgo.test/api/v2/user/dirs?path=%2Fnewdir", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { message: string; error: string };
    expect(typeof body.message).toBe("string");
    expect(typeof body.error).toBe("string");

    await expect(client.user(token).mkdir("/newdir")).rejects.toMatchObject({ kind: "server" });
  });

  it("shows a virtual folder mount as a directory entry, sized 0, in its parent listing", async () => {
    const fixed = new Date("2024-07-01T00:00:00Z");
    const server = createFakeSftpgoServer({
      users: [
        {
          username: "carol",
          password: "secret",
          permissions: { "/": FULL_PERMS },
          virtualFolders: [{ name: "shared", virtualPath: "/shared" }],
        },
      ],
      folders: [{ name: "shared" }],
      files: { "@shared": { "/team.txt": "hi" }, carol: { "/own.txt": "mine" } },
      now: () => fixed,
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "carol", password: "secret" })).accessToken;

    const entries = await client.user(token).list("/");
    const shared = entries.find((entry) => entry.name === "shared");
    expect(shared).toMatchObject({ kind: "dir", size: 0 });
    expect(shared?.modifiedAt).toEqual(fixed);
    expect(entries.map((entry) => entry.name)).toContain("own.txt");
  });

  it("does not show a mount at a nested path when listing an unrelated directory", async () => {
    const server = createFakeSftpgoServer({
      users: [
        {
          username: "carol",
          password: "secret",
          permissions: { "/": FULL_PERMS },
          virtualFolders: [{ name: "shared", virtualPath: "/shared" }],
        },
      ],
      folders: [{ name: "shared" }],
      files: { carol: { "/other/note.txt": "mine" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "carol", password: "secret" })).accessToken;
    const entries = await client.user(token).list("/other");
    expect(entries.map((entry) => entry.name)).toEqual(["note.txt"]);
  });

  it("names authenticated streamzip entries by path relative to the root, directory prefix included", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/docs/readme.md": "hi", "/docs/report.pdf": "bye" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;

    const fileStream = await client.user(token).zip(["/docs/readme.md"]);
    const fileEntries = parseZipCentralDirectory(await readAll(fileStream));
    expect(fileEntries.map((entry) => entry.name)).toEqual(["docs/readme.md"]);

    const dirStream = await client.user(token).zip(["/docs"]);
    const dirEntries = parseZipCentralDirectory(await readAll(dirStream));
    expect(dirEntries.map((entry) => entry.name).sort()).toEqual([
      "docs/readme.md",
      "docs/report.pdf",
    ]);
  });

  it("zips the root path directly with entry names carrying no leading slash", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/a.txt": "hi" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const stream = await client.user(token).zip(["/"]);
    const entries = parseZipCentralDirectory(await readAll(stream));
    expect(entries.map((entry) => entry.name)).toEqual(["a.txt"]);
  });

  it("flattens a public single-directory share zip relative to the share root, plus a / entry", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/docs/readme.md": "hi", "/docs/report.pdf": "bye" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/docs"] });

    const stream = await client.publicShare(created.id).zip();
    const entries = parseZipCentralDirectory(await readAll(stream));
    expect(entries.map((entry) => entry.name).sort()).toEqual(["/", "readme.md", "report.pdf"]);
  });

  it("names a public multi-path share's zip entries by path relative to the root", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
      files: { alice: { "/docs/readme.md": "hi", "/photo.jpg": "bin" } },
    });
    const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
    const token = (await client.login({ username: "alice", password: "secret" })).accessToken;
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/docs/readme.md", "/photo.jpg"] });

    const stream = await client.publicShare(created.id).zip();
    const entries = parseZipCentralDirectory(await readAll(stream));
    expect(entries.map((entry) => entry.name).sort()).toEqual(["docs/readme.md", "photo.jpg"]);
  });
});
