import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PostgresContainer } from "../../src/containers/postgres.js";
import { startPostgres } from "../../src/containers/postgres.js";
import type { SftpgoContainer } from "../../src/containers/sftpgo.js";
import { startSftpgo } from "../../src/containers/sftpgo.js";
import { SEED_USERS } from "../../src/seed-data.js";

interface DirEntry {
  readonly name: string;
}

function seedUser(username: string): { username: string; password: string } {
  const user = SEED_USERS.find((candidate) => candidate.username === username);
  if (!user) {
    throw new Error(`No seed user named "${username}" in SEED_USERS`);
  }
  return user;
}

async function tokenFor(baseUrl: string, username: string, password: string): Promise<string> {
  const credentials = Buffer.from(`${username}:${password}`).toString("base64");
  const response = await fetch(`${baseUrl}/api/v2/user/token`, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

async function listDir(baseUrl: string, token: string, path: string): Promise<DirEntry[]> {
  const response = await fetch(`${baseUrl}/api/v2/user/dirs?path=${encodeURIComponent(path)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DirEntry[];
}

async function assertTcpReachable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.end();
      resolve();
    });
    socket.on("error", reject);
  });
}

describe("testkit containers", () => {
  let sftpgo: SftpgoContainer;
  let postgres: PostgresContainer;

  beforeAll(async () => {
    [sftpgo, postgres] = await Promise.all([startSftpgo(), startPostgres()]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([sftpgo?.stop(), postgres?.stop()]);
  }, 180_000);

  it("sftpgo container reports healthy", async () => {
    const response = await fetch(`${sftpgo.baseUrl}/healthz`);
    expect(response.status).toBe(200);
  });

  it("postgres container accepts TCP connections", async () => {
    const url = new URL(postgres.connectionString);
    await assertTcpReachable(url.hostname, Number(url.port));
  });

  it("alice logs in and lists her seeded root", async () => {
    const alice = seedUser("alice");
    const token = await tokenFor(sftpgo.baseUrl, alice.username, alice.password);
    const entries = await listDir(sftpgo.baseUrl, token, "/");
    const names = entries.map((entry) => entry.name);

    expect(names).toContain("docs");
    expect(names).toContain("photo.jpg");
  });

  it("bob logs in and lists his seeded root", async () => {
    const bob = seedUser("bob");
    const token = await tokenFor(sftpgo.baseUrl, bob.username, bob.password);
    const entries = await listDir(sftpgo.baseUrl, token, "/");
    const names = entries.map((entry) => entry.name);

    expect(names).toContain("inbox");
    expect(names).toContain("public");
  });

  it("bob gets 403 creating a directory at the root but 201 inside /inbox", async () => {
    const bob = seedUser("bob");
    const token = await tokenFor(sftpgo.baseUrl, bob.username, bob.password);

    const rootAttempt = await fetch(`${sftpgo.baseUrl}/api/v2/user/dirs?path=/newdir`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(rootAttempt.status).toBe(403);

    const inboxAttempt = await fetch(`${sftpgo.baseUrl}/api/v2/user/dirs?path=/inbox/newdir`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(inboxAttempt.status).toBe(201);
  });

  it("carol sees the shared folder at her root and team.txt inside it", async () => {
    const carol = seedUser("carol");
    const token = await tokenFor(sftpgo.baseUrl, carol.username, carol.password);

    const rootEntries = await listDir(sftpgo.baseUrl, token, "/");
    expect(rootEntries.map((entry) => entry.name)).toContain("shared");

    const sharedEntries = await listDir(sftpgo.baseUrl, token, "/shared");
    expect(sharedEntries.map((entry) => entry.name)).toContain("team.txt");
  });
});
