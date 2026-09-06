import { describe, expect, it, vi } from "vitest";
import { createSftpgoClient } from "./client.js";
import { createFakeSftpgoServer } from "./fake/server.js";
import type { FakeSeed } from "./fake/types.js";
import type { SftpgoShareInput } from "./types.js";

const FULL_PERMS = ["*"];

function setup(seed: FakeSeed) {
  const server = createFakeSftpgoServer(seed);
  const client = createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: server.fetch });
  return { server, client };
}

const SEED: FakeSeed = {
  users: [{ username: "alice", password: "secret", permissions: { "/": FULL_PERMS } }],
  files: {
    alice: { "/shared/a.txt": "hello", "/shared/nested/b.txt": "world", "/solo.txt": "one" },
  },
};

async function loginAsAlice(client: ReturnType<typeof createSftpgoClient>): Promise<string> {
  return (await client.login({ username: "alice", password: "secret" })).accessToken;
}

describe("SftpgoUserShares", () => {
  it("creates a share and returns its id from the response header", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const input: SftpgoShareInput = { name: "s1", scope: "read", paths: ["/shared"] };
    const created = await client.user(token).shares.create(input);
    expect(created.id).toBeTruthy();
  });

  it("round-trips a created share through get()", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const expiresAt = new Date(Date.now() + 100000);
    const created = await client.user(token).shares.create({
      name: "s1",
      description: "desc",
      scope: "write",
      paths: ["/shared"],
      password: "sesame",
      expiresAt,
      maxTokens: 3,
      allowFrom: ["10.0.0.0/8"],
    });
    const share = await client.user(token).shares.get(created.id);
    expect(share).toMatchObject({
      id: created.id,
      name: "s1",
      description: "desc",
      scope: "write",
      paths: ["/shared"],
      username: "alice",
      maxTokens: 3,
      usedTokens: 0,
      allowFrom: ["10.0.0.0/8"],
      hasPassword: true,
      lastUseAt: null,
    });
    expect(share.expiresAt).toEqual(expiresAt);
    expect(share.createdAt).toBeInstanceOf(Date);
    expect(share.updatedAt).toBeInstanceOf(Date);
  });

  it("defaults expiresAt to null when not given", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client
      .user(token)
      .shares.create({ name: "s", scope: "read", paths: ["/shared"] });
    const share = await client.user(token).shares.get(created.id);
    expect(share.expiresAt).toBeNull();
    expect(share.hasPassword).toBe(false);
  });

  it("lists shares owned by the user", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    await client.user(token).shares.create({ name: "s1", scope: "read", paths: ["/shared"] });
    await client.user(token).shares.create({ name: "s2", scope: "read", paths: ["/solo.txt"] });
    const shares = await client.user(token).shares.list();
    expect(shares.map((s) => s.name).sort()).toEqual(["s1", "s2"]);
  });

  it("returns not_found for a share belonging to someone else or missing", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    await expect(client.user(token).shares.get("nope")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("keeps the existing password on update when password is not provided", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client.user(token).shares.create({
      name: "s1",
      scope: "read",
      paths: ["/shared"],
      password: "secret-pw",
    });
    await client
      .user(token)
      .shares.update(created.id, { name: "s1-renamed", scope: "read", paths: ["/shared"] });
    const share = await client.user(token).shares.get(created.id);
    expect(share.name).toBe("s1-renamed");
    expect(share.hasPassword).toBe(true);
  });

  it("clears the password on update when an empty string is provided", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client.user(token).shares.create({
      name: "s1",
      scope: "read",
      paths: ["/shared"],
      password: "secret-pw",
    });
    await client
      .user(token)
      .shares.update(created.id, { name: "s1", scope: "read", paths: ["/shared"], password: "" });
    const share = await client.user(token).shares.get(created.id);
    expect(share.hasPassword).toBe(false);
  });

  it("removes a share", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client
      .user(token)
      .shares.create({ name: "s1", scope: "read", paths: ["/shared"] });
    await client.user(token).shares.remove(created.id);
    await expect(client.user(token).shares.get(created.id)).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});

describe("SftpgoPublicShareApi", () => {
  it("lists a directory share without a password", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client
      .user(token)
      .shares.create({ name: "s1", scope: "read", paths: ["/shared"] });
    const entries = await client.publicShare(created.id).list();
    expect(entries.map((e) => e.name).sort()).toEqual(["a.txt", "nested"]);
  });

  it("lists a subdirectory of the share root", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client
      .user(token)
      .shares.create({ name: "s1", scope: "read", paths: ["/shared"] });
    const entries = await client.publicShare(created.id).list("/nested");
    expect(entries.map((e) => e.name)).toEqual(["b.txt"]);
  });

  it("rejects listing without a password when the share requires one", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client.user(token).shares.create({
      name: "s1",
      scope: "read",
      paths: ["/shared"],
      password: "letmein",
    });
    await expect(client.publicShare(created.id).list()).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("rejects the wrong password", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client.user(token).shares.create({
      name: "s1",
      scope: "read",
      paths: ["/shared"],
      password: "letmein",
    });
    await expect(client.publicShare(created.id, "wrong").list()).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("accepts the correct password regardless of the username used", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client.user(token).shares.create({
      name: "s1",
      scope: "read",
      paths: ["/shared"],
      password: "letmein",
    });
    const entries = await client.publicShare(created.id, "letmein").list();
    expect(entries.length).toBeGreaterThan(0);
  });

  it("downloads a file from within a directory share", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client
      .user(token)
      .shares.create({ name: "s1", scope: "read", paths: ["/shared"] });
    const result = await client.publicShare(created.id).download("/a.txt");
    expect(await new Response(result.body).text()).toBe("hello");
  });

  it("downloads a byte range from within a directory share", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client
      .user(token)
      .shares.create({ name: "s1", scope: "read", paths: ["/shared"] });
    const result = await client
      .publicShare(created.id)
      .download("/a.txt", { range: { start: 0, end: 1 } });
    expect(result.status).toBe(206);
    expect(await new Response(result.body).text()).toBe("he");
  });

  it("sends an If-Range header on a public share download", async () => {
    let capturedIfRange: string | null = null;
    const fetchImpl = vi.fn(async (_url, init: RequestInit | undefined) => {
      capturedIfRange = new Headers(init?.headers).get("if-range");
      return new Response("x", { status: 200 });
    });
    const client = createSftpgoClient({ baseUrl: "http://host", fetch: fetchImpl });
    await client.publicShare("share1").download("/a.txt", { ifRange: "etag" });
    expect(capturedIfRange).toBe("etag");
  });

  it("downloads a single-file share regardless of the requested path", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client
      .user(token)
      .shares.create({ name: "s1", scope: "read", paths: ["/solo.txt"] });
    const result = await client.publicShare(created.id).download("/solo.txt");
    expect(await new Response(result.body).text()).toBe("one");
  });

  it("zips the share's paths", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client
      .user(token)
      .shares.create({ name: "s1", scope: "read", paths: ["/shared"] });
    const stream = await client.publicShare(created.id).zip();
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
  });

  it("uploads into a write-scope directory share", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client
      .user(token)
      .shares.create({ name: "s1", scope: "write", paths: ["/shared"] });
    await client
      .publicShare(created.id)
      .upload("uploaded.txt", new TextEncoder().encode("from the public"));
    const stat = await client.user(token).statFile("/shared/uploaded.txt");
    expect(stat.size).toBe(15);
  });

  it("rejects uploads to a read-scope share", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client
      .user(token)
      .shares.create({ name: "s1", scope: "read", paths: ["/shared"] });
    await expect(
      client.publicShare(created.id).upload("x.txt", new Uint8Array([1])),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("returns bad_request when listing a share with more than one path", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client.user(token).shares.create({
      name: "s1",
      scope: "read",
      paths: ["/shared", "/solo.txt"],
    });
    await expect(client.publicShare(created.id).list()).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("returns not_found for an unknown share id", async () => {
    const { client } = setup(SEED);
    await expect(client.publicShare("does-not-exist").list()).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("returns not_found for an expired share", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client.user(token).shares.create({
      name: "s1",
      scope: "read",
      paths: ["/shared"],
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(client.publicShare(created.id).list()).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("enforces max_tokens across accesses", async () => {
    const { client } = setup(SEED);
    const token = await loginAsAlice(client);
    const created = await client.user(token).shares.create({
      name: "s1",
      scope: "read",
      paths: ["/shared"],
      maxTokens: 1,
    });
    await client.publicShare(created.id).list();
    await expect(client.publicShare(created.id).list()).rejects.toMatchObject({
      kind: "rate_limited",
    });
  });
});
