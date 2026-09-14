import { connect } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startSftpgo } from "@fdrive/testkit";
import { Client } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSftpgoClient } from "../../src/client.js";
import { SFTPGO_LEASE_HEADER, withSftpgoWriteLease } from "../../src/write-lease.js";

describe("qualified SFTPGo storage enforcement across protocols", () => {
  let container: Awaited<ReturnType<typeof startSftpgo>>;
  let client: ReturnType<typeof createSftpgoClient>;
  let jwt: string;
  let bob: string;
  let carol: string;
  const body = Buffer.from("original");

  beforeAll(async () => {
    container = await startSftpgo({ enforcedWriteUsers: ["alice", "bob", "carol", "quota"] });
    client = createSftpgoClient({ baseUrl: container.baseUrl });
    jwt = (await client.login({ username: "alice", password: "alice-password" })).accessToken;
    bob = (await client.login({ username: "bob", password: "bob-password" })).accessToken;
    carol = (await client.login({ username: "carol", password: "carol-password" })).accessToken;
  }, 600_000);
  afterAll(async () => {
    await container?.stop();
  });

  function request(path: string, method: string, lease?: string, user = jwt, bytes?: string) {
    return fetch(`${container.baseUrl}/api/v2/user/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${user}`,
        ...(lease ? { [SFTPGO_LEASE_HEADER]: lease } : {}),
      },
      ...(bytes === undefined ? {} : { body: bytes }),
      signal: AbortSignal.timeout(10_000),
    });
  }
  async function acquire() {
    const response = await request("fdrive/lease", "POST");
    expect(response.status, await response.clone().text()).toBe(200);
    const value = (await response.json()) as {
      token: string;
      protocol: string;
      timeoutSeconds: number;
    };
    expect(value).toMatchObject({ protocol: "fdrive-local-v1", timeoutSeconds: 60 });
    expect(value.token).toMatch(/^[a-f0-9]{64}$/);
    return value.token;
  }
  async function ssh() {
    const connection = new Client();
    await new Promise<void>((resolve, reject) => {
      connection
        .once("ready", resolve)
        .once("error", reject)
        .connect({ ...container.sftp, username: "alice", password: "alice-password" });
    });
    const sftp = await promisify(connection.sftp.bind(connection))();
    return { connection, sftp };
  }

  it("blocks acquisition until an already-open SFTP writer closes", async () => {
    const { connection, sftp } = await ssh();
    try {
      const handle = await promisify(sftp.open.bind(sftp))("/held.txt", "w");
      try {
        await promisify(sftp.write.bind(sftp))(handle, body, 0, body.length, 0);
        const response = await request("fdrive/lease", "POST");
        expect(response.status).toBe(409);
      } finally {
        await promisify(sftp.close.bind(sftp))(handle);
      }
      const token = await acquire();
      expect((await request("fdrive/lease", "DELETE", token)).status).toBe(204);
    } finally {
      connection.end();
    }
  });

  it("blocks ordinary REST, SFTP, WebDAV and FTP mutations while reads and leased writes work", async () => {
    await client.user(jwt).upload("/protected.txt", body);
    const { connection, sftp } = await ssh();
    const ftp = connect(container.ftp);
    const lines = createInterface({ input: ftp })[Symbol.asyncIterator]();
    async function reply() {
      for (;;) {
        const line = await lines.next();
        if (line.done) throw Error("FTP closed");
        if (/^\d{3} /.test(line.value)) return Number(line.value.slice(0, 3));
      }
    }
    const command = async (text: string) => {
      ftp.write(`${text}\r\n`);
      return reply();
    };
    expect(await reply()).toBe(220);
    expect(await command("USER alice")).toBe(331);
    expect(await command("PASS alice-password")).toBe(230);
    const token = await acquire();
    try {
      expect(
        (await request("files/upload?path=%2Fprotected.txt", "POST", undefined, jwt, "bad")).status,
      ).toBe(403);
      expect((await request("dirs?path=%2Fblocked", "POST")).status).toBe(403);
      expect(
        (await request("file-actions/move?path=%2Fprotected.txt&target=%2Flost.txt", "POST"))
          .status,
      ).toBe(403);
      expect((await request("files?path=%2Fprotected.txt", "DELETE")).status).toBe(403);
      // Bob has upload permission in /inbox; the namespace gate covers other users too.
      expect(
        (await request("files/upload?path=%2Finbox%2Fblocked.txt", "POST", undefined, bob, "bad"))
          .status,
      ).toBe(403);
      await expect(promisify(sftp.open.bind(sftp))("/protected.txt", "w")).rejects.toThrow();
      await expect(
        promisify(sftp.rename.bind(sftp))("/protected.txt", "/lost.txt"),
      ).rejects.toThrow();
      await expect(promisify(sftp.unlink.bind(sftp))("/protected.txt")).rejects.toThrow();
      expect(await command("DELE protected.txt")).toBe(550);
      expect(await command("MKD blocked-ftp")).toBe(550);
      const auth = `Basic ${Buffer.from("alice:alice-password").toString("base64")}`;
      expect(
        (
          await fetch(`${container.webdavUrl}/protected.txt`, {
            method: "PUT",
            headers: { Authorization: auth },
            body: "bad",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${container.webdavUrl}/protected.txt`, {
            method: "DELETE",
            headers: { Authorization: auth },
          })
        ).status,
      ).toBe(403);
      expect(
        await (
          await fetch(`${container.webdavUrl}/protected.txt`, { headers: { Authorization: auth } })
        ).text(),
      ).toBe("original");
      expect(
        (await request("files/upload?path=%2Fstage.txt", "POST", token, jwt, "new")).status,
      ).toBe(201);
      expect(
        (
          await request(
            "file-actions/move?path=%2Fstage.txt&target=%2Fprotected.txt",
            "POST",
            token,
          )
        ).status,
      ).toBe(200);
      expect(
        await new Response((await client.user(jwt).download("/protected.txt")).body).text(),
      ).toBe("new");
    } finally {
      await request("fdrive/lease", "DELETE", token);
      connection.end();
      ftp.destroy();
    }
    await client.user(jwt).upload("/protected.txt", body);
  });

  it("preserves owner binding, user permissions and the no-virtual-folder qualification", async () => {
    expect((await request("fdrive/lease", "POST", undefined, carol)).status).toBe(403);
    const token = await acquire();
    try {
      expect((await request("fdrive/lease", "PATCH", token, bob)).status).toBe(409);
      expect(
        (await request("files/upload?path=%2Finbox%2Fstolen.txt", "POST", token, bob, "bad"))
          .status,
      ).toBe(409);
    } finally {
      await request("fdrive/lease", "DELETE", token);
    }
    const response = await request("fdrive/lease", "POST", undefined, bob);
    expect(response.status).toBe(200);
    const own = ((await response.json()) as { token: string }).token;
    try {
      expect(
        (await request("files/upload?path=%2Fforbidden.txt", "POST", own, bob, "bad")).status,
      ).toBe(403);
      expect(
        (await request("files/upload?path=%2Finbox%2Fallowed.txt", "POST", own, bob, "good"))
          .status,
      ).toBe(201);
    } finally {
      await request("fdrive/lease", "DELETE", own, bob);
    }
  });

  it("fences released and genuinely expired tokens before publication, including after a new lease", async () => {
    await client.user(jwt).upload("/survivor.txt", body);
    const token = await acquire();
    expect(
      (await request("files/upload?path=%2Fexpired-stage.txt", "POST", token, jwt, "bad")).status,
    ).toBe(201);
    await delay(61_000);
    expect((await request("fdrive/lease", "PATCH", token)).status).toBe(409);
    expect(
      (
        await request(
          "file-actions/move?path=%2Fexpired-stage.txt&target=%2Fsurvivor.txt",
          "POST",
          token,
        )
      ).status,
    ).toBe(409);
    const next = await acquire();
    expect(next).not.toBe(token);
    expect(
      (await request("files/upload?path=%2Fsurvivor.txt", "POST", token, jwt, "bad")).status,
    ).toBe(409);
    expect((await request("fdrive/lease", "DELETE", next)).status).toBe(204);
    expect((await request("files?path=%2Fsurvivor.txt", "DELETE", next)).status).toBe(409);
    expect(await new Response((await client.user(jwt).download("/survivor.txt")).body).text()).toBe(
      "original",
    );
  }, 90_000);

  it("keeps upstream quota checks on leased uploads", async () => {
    const login = await fetch(`${container.baseUrl}/api/v2/token`, {
      headers: {
        Authorization: `Basic ${Buffer.from("admin:admin-password-for-tests").toString("base64")}`,
      },
    });
    expect(login.status).toBe(200);
    const admin = ((await login.json()) as { access_token: string }).access_token;
    const created = await fetch(`${container.baseUrl}/api/v2/users`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "quota",
        password: "quota-test-password",
        status: 1,
        home_dir: "/srv/sftpgo/data/quota",
        permissions: { "/": ["*"] },
        quota_size: 4,
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const user = (await client.login({ username: "quota", password: "quota-test-password" }))
      .accessToken;
    const response = await request("fdrive/lease", "POST", undefined, user);
    expect(response.status).toBe(200);
    const token = ((await response.json()) as { token: string }).token;
    try {
      const denied = await request(
        "files/upload?path=%2Ftoo-big.txt",
        "POST",
        token,
        user,
        "12345",
      );
      expect(denied.status).toBe(413);
      expect(await denied.json()).toMatchObject({ error: "denying write due to space limit" });
      expect(
        (await request("files/upload?path=%2Ffits.txt", "POST", token, user, "1234")).status,
      ).toBe(201);
    } finally {
      await request("fdrive/lease", "DELETE", token, user);
    }
  });

  it("runs the real adapter with no-overwrite checks and automatic renewal", async () => {
    const options = {
      baseUrl: container.baseUrl,
      fetch,
      withToken: async <T>(fn: (token: string) => Promise<T>) => fn(jwt),
      renewIntervalMs: 50,
    };
    await withSftpgoWriteLease(options, async (storage) => {
      await storage.upload("/adapter.txt", body, { overwrite: false });
      await delay(150);
      await expect(
        storage.upload("/adapter.txt", body, { overwrite: false }),
      ).rejects.toMatchObject({ kind: "conflict" });
      await storage.move("/adapter.txt", "/adapter-moved.txt", { overwrite: false });
      expect(await new Response((await storage.download("/adapter-moved.txt")).body).text()).toBe(
        "original",
      );
    });
    await client.user(jwt).deleteFile("/adapter-moved.txt");
  });
});

it("never starts a native mutation against stock SFTPGo even when the mode is misconfigured", async () => {
  const container = await startSftpgo();
  try {
    const client = createSftpgoClient({ baseUrl: container.baseUrl });
    const jwt = (await client.login({ username: "alice", password: "alice-password" })).accessToken;
    let called = false;
    await expect(
      withSftpgoWriteLease(
        {
          baseUrl: container.baseUrl,
          fetch,
          withToken: async <T>(fn: (jwt: string) => Promise<T>) => fn(jwt),
        },
        async (storage) => {
          called = true;
          await storage.upload("/unsafe.txt", Buffer.from("bad"));
        },
      ),
    ).rejects.toMatchObject({ kind: "upstream_unavailable" });
    expect(called).toBe(false);
    await expect(client.user(jwt).statFile("/unsafe.txt")).rejects.toMatchObject({
      kind: "not_found",
    });
  } finally {
    await container.stop();
  }
});
