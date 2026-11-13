import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PostgresContainer } from "../../src/containers/postgres.js";
import { startPostgres } from "../../src/containers/postgres.js";
import { type ApacheWebdavContainer, startApacheWebdav } from "../../src/containers/webdav.js";

async function assertTcpReachable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.end();
      resolve();
    });
    socket.on("error", reject);
  });
}

function basic(user: { username: string; password: string }): string {
  return `Basic ${Buffer.from(`${user.username}:${user.password}`).toString("base64")}`;
}

function userNamed(dav: ApacheWebdavContainer, username: string) {
  const user = dav.users.find((candidate) => candidate.username === username);
  if (user === undefined) throw new Error(`no WebDAV user ${username}`);
  return user;
}

async function propfind(url: string, authorization?: string): Promise<Response> {
  return fetch(url, {
    method: "PROPFIND",
    headers: { Depth: "1", ...(authorization === undefined ? {} : { authorization }) },
  });
}

describe("testkit containers", () => {
  let postgres: PostgresContainer;
  let single: ApacheWebdavContainer;
  let multi: ApacheWebdavContainer;

  beforeAll(async () => {
    [postgres, single, multi] = await Promise.all([
      startPostgres(),
      startApacheWebdav(),
      startApacheWebdav({
        users: [
          { username: "alice", password: "alice-password" },
          { username: "bob", password: 'bob\'s "quoted" password', readOnly: true },
        ],
        files: {
          alice: { "/docs/readme.md": "alice's readme" },
          bob: { "/notes.txt": "bob's notes" },
        },
      }),
    ]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([postgres?.stop(), single?.stop(), multi?.stop()]);
  }, 180_000);

  it("postgres container accepts TCP connections", async () => {
    const url = new URL(postgres.connectionString);
    await assertTcpReachable(url.hostname, Number(url.port));
  });

  it("serves one login at /dav/ by default and asks anyone else to sign in", async () => {
    expect(single.baseUrl).toMatch(/\/dav\/$/);
    expect(single.users).toEqual([{ ...single.credential, baseUrl: single.baseUrl }]);
    const anonymous = await fetch(single.baseUrl, { method: "OPTIONS" });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toMatch(/^Basic/);
    const put = await fetch(new URL("hello.txt", single.baseUrl), {
      method: "PUT",
      headers: { authorization: basic(single.credential) },
      body: "hello",
    });
    expect(put.status).toBe(201);
    const listing = await propfind(single.baseUrl, basic(single.credential));
    expect(listing.status).toBe(207);
    expect(await listing.text()).toContain("hello.txt");
  });

  it("gives each login a home of its own with its seeded files", async () => {
    const alice = userNamed(multi, "alice");
    const bob = userNamed(multi, "bob");
    expect(multi.baseUrl).toBe(alice.baseUrl);
    expect(multi.credential).toEqual({ username: "alice", password: "alice-password" });
    expect(alice.baseUrl).toMatch(/\/dav\/alice\/$/);
    expect(bob.baseUrl).toMatch(/\/dav\/bob\/$/);

    const readme = await fetch(new URL("docs/readme.md", alice.baseUrl), {
      headers: { authorization: basic(alice) },
    });
    expect(await readme.text()).toBe("alice's readme");
    // A login cannot open another login's home.
    expect((await propfind(bob.baseUrl, basic(alice))).status).toBe(401);
    expect((await propfind(alice.baseUrl, basic(bob))).status).toBe(401);
  });

  it("lets a read-only login read its home and refuses every change with 403", async () => {
    const bob = userNamed(multi, "bob");
    const notes = await fetch(new URL("notes.txt", bob.baseUrl), {
      headers: { authorization: basic(bob) },
    });
    expect(await notes.text()).toBe("bob's notes");
    expect((await propfind(bob.baseUrl, basic(bob))).status).toBe(207);
    for (const [method, path] of [
      ["PUT", "new.txt"],
      ["MKCOL", "folder"],
      ["DELETE", "notes.txt"],
    ] as const) {
      const response = await fetch(new URL(path, bob.baseUrl), {
        method,
        headers: { authorization: basic(bob) },
        ...(method === "PUT" ? { body: "x" } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });
});
