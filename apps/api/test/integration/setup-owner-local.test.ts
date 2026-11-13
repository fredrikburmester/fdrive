import { createDb } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";

function capturingLogger(): { logger: Logger; messages: string[] } {
  const messages: string[] = [];
  const record = (value: unknown) => {
    if (typeof value === "string") messages.push(value);
  };
  return {
    logger: {
      info: record,
      warn: record,
      error: () => undefined,
      debug: () => undefined,
      fatal: () => undefined,
      trace: () => undefined,
    } as unknown as Logger,
    messages,
  };
}

function setupHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-requested-with": "fdrive",
    "x-setup-token": token,
  };
}

/**
 * The first start of a deployment with a local folder and no users: the
 * owner picks a username and password in setup, which becomes the first
 * local user and the administrator. Exactly one owner can claim the folder.
 */
describe("setup owner on a local folder", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>> | undefined;
  let storage: Awaited<ReturnType<typeof startLocalStorage>> | undefined;

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({ users: [], files: {} }),
    ]);
  }, 180_000);

  afterAll(async () => {
    await storage?.stop();
    await postgres?.stop();
  }, 180_000);

  it("refuses to finish setup on a deployment without a files folder, naming the variable", async () => {
    if (postgres === undefined) throw new Error("test fixtures did not start");
    const admin = createDb(postgres.connectionString);
    await admin.db.execute(sql.raw("create database setup_without_folder"));
    await admin.close();
    const url = new URL(postgres.connectionString);
    url.pathname = "/setup_without_folder";
    const { logger, messages } = capturingLogger();
    const config = loadConfig({
      DATABASE_URL: url.toString(),
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 92).toString("base64"),
    });
    const composed = await composeApp(config, logger, () => new Date());
    const inspection = createDb(url.toString());
    try {
      const status = await composed.app.request("/api/v1/setup/status");
      expect(await status.json()).toEqual({ required: true, storageConfigured: false });
      const tokenLine = messages.find((message) => message.startsWith("setup token: "));
      if (tokenLine === undefined) throw new Error("expected setup token");
      const refused = await composed.app.request("/api/v1/setup/complete", {
        method: "POST",
        headers: setupHeaders(tokenLine.slice("setup token: ".length)),
        body: JSON.stringify({ username: "alice", password: "alice-password" }),
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: { kind: "bad_request", message: expect.stringContaining("FDRIVE_STORAGE_ROOT") },
      });
      const counts = await inspection.db.execute(sql`
        select (select count(*)::int from app.accounts) as accounts,
          (select count(*)::int from app.providers) as providers,
          (select count(*)::int from app.local_users) as users
      `);
      expect(counts.rows[0]).toEqual({ accounts: 0, providers: 0, users: 0 });
    } finally {
      await composed.close();
      await inspection.close();
    }
  });

  it("keeps a refused owner setup resumable and lets exactly one owner claim the folder", async () => {
    if (postgres === undefined || storage === undefined)
      throw new Error("test fixtures did not start");
    const { logger, messages } = capturingLogger();
    const config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      FDRIVE_STORAGE_ROOT: storage.root,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 91).toString("base64"),
    });
    const composed = await composeApp(config, logger, () => new Date());
    const inspection = createDb(postgres.connectionString);
    const complete = (token: string, body: unknown) =>
      composed.app.request("/api/v1/setup/complete", {
        method: "POST",
        headers: setupHeaders(token),
        body: JSON.stringify(body),
      });

    try {
      const tokenLine = messages.find((message) => message.startsWith("setup token: "));
      if (tokenLine === undefined) throw new Error("expected setup token");
      const token = tokenLine.slice("setup token: ".length);

      // Without the logged token, and with a name or password the folder
      // cannot take, nothing is created and setup stays open.
      expect(
        (await complete("not-the-token", { username: "alice", password: "pw-long-enough" })).status,
      ).toBe(401);
      expect(
        (await complete(token, { username: "../alice", password: "pw-long-enough" })).status,
      ).toBe(400);
      expect((await complete(token, { username: "alice", password: "short" })).status).toBe(400);
      // Setup connects no other storage.
      expect(
        (
          await complete(token, {
            kind: "provider",
            type: "webdav",
            baseUrl: "http://elsewhere.invalid/dav/",
            credential: { username: "alice", password: "pw-long-enough" },
          })
        ).status,
      ).toBe(400);
      const status = await composed.app.request("/api/v1/setup/status");
      expect(await status.json()).toEqual({ required: true, storageConfigured: true });
      const untouched = await inspection.db.execute(
        sql`select count(*)::int as users from app.local_users`,
      );
      expect(untouched.rows[0]).toEqual({ users: 0 });

      const results = await Promise.all(
        [
          { username: "alice", password: "alice-password" },
          { username: "bob", password: "bob-password" },
        ].map((owner) => complete(token, owner)),
      );
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const claimed = results.find((result) => result.status === 200);
      if (claimed === undefined) throw new Error("missing winning claim");
      const winner = (await claimed.json()) as {
        isAdmin: boolean;
        identities: { username: string }[];
      };
      expect(winner.isAdmin).toBe(true);
      const owner = winner.identities[0]?.username;
      expect(["alice", "bob"]).toContain(owner);

      // Only the winner's user remains: the loser's was removed with its claim.
      const counts = await inspection.db.execute(sql`
        select (select count(*)::int from app.accounts) as accounts,
          (select count(*)::int from app.identities) as identities,
          (select count(*)::int from app.sessions) as sessions,
          (select count(*)::int from app.providers) as providers,
          (select count(*)::int from app.local_users) as users
      `);
      expect(counts.rows[0]).toEqual({
        accounts: 1,
        identities: 1,
        sessions: 1,
        providers: 1,
        users: 1,
      });
      const users = await inspection.db.execute(sql`select username from app.local_users`);
      expect(users.rows).toEqual([{ username: owner }]);
      const cookie = claimed.headers.get("set-cookie")?.split(";")[0];
      if (cookie === undefined) throw new Error("expected owner session cookie");
      expect(cookie).toContain("fdrive_session=");

      // Setup is over: the token is spent and the owner signs in with the password they chose.
      expect(
        (await complete(token, { username: "carol", password: "carol-password" })).status,
      ).toBe(404);
      const login = await composed.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
        body: JSON.stringify({
          credential: { username: owner, password: `${owner}-password` },
        }),
      });
      expect(login.status).toBe(200);
    } finally {
      await composed.close();
      await inspection.close();
    }
  });
});
