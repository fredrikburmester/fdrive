import { createDb } from "@fdrive/db";
import { type SftpgoContainer, startPostgres, startSftpgo } from "@fdrive/testkit";
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

describe("setup owner against SFTPGo v2.7.5", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>> | undefined;
  let sftpgo: SftpgoContainer | undefined;

  beforeAll(async () => {
    postgres = await startPostgres();
    sftpgo = await startSftpgo({
      users: [
        { username: "alice", password: "alice-pass", permissions: { "/": ["*"] } },
        { username: "bob", password: "bob-pass", permissions: { "/": ["*"] } },
      ],
      folders: [],
      files: {},
    });
  }, 180_000);

  afterAll(async () => {
    await sftpgo?.stop();
    await postgres?.stop();
  }, 180_000);

  it("keeps a failed owner login resumable and binds the real candidate", async () => {
    if (postgres === undefined || sftpgo === undefined)
      throw new Error("test fixtures did not start");
    const { logger, messages } = capturingLogger();
    const config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 91).toString("base64"),
    });
    let release!: () => void;
    const bothVerified = new Promise<void>((resolve) => {
      release = resolve;
    });
    let verified = 0;
    const composed = await composeApp(config, logger, () => new Date(), {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/api/v2/user/token" && response.ok) {
          if (++verified === 2) release();
          await bothVerified;
        }
        return response;
      },
    });
    const inspection = createDb(postgres.connectionString);

    try {
      const tokenLine = messages.find((message) => message.startsWith("setup token: "));
      if (tokenLine === undefined) throw new Error("expected setup token");
      const token = tokenLine.slice("setup token: ".length);
      const failed = await composed.app.request("/api/v1/setup/complete", {
        method: "POST",
        headers: setupHeaders(token),
        body: JSON.stringify({
          baseUrl: sftpgo.baseUrl,
          homeTemplate: "sftpgo:/{username}",
          username: "alice",
          password: "wrong",
        }),
      });
      expect(failed.status).toBe(401);
      const status = await composed.app.request("/api/v1/setup/status");
      expect(await status.json()).toEqual({
        required: true,
        hasEnvUrl: false,
      });

      const alternate = new URL(sftpgo.baseUrl);
      alternate.hostname = alternate.hostname === "localhost" ? "127.0.0.1" : "localhost";
      const results = await Promise.all(
        [
          { username: "alice", password: "alice-pass", baseUrl: sftpgo.baseUrl },
          { username: "bob", password: "bob-pass", baseUrl: alternate.origin },
        ].map((candidate) =>
          composed.app.request("/api/v1/setup/complete", {
            method: "POST",
            headers: setupHeaders(token),
            body: JSON.stringify({ ...candidate, homeTemplate: "sftpgo:/{username}" }),
          }),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const claimed = results.find((result) => result.status === 200);
      if (claimed === undefined) throw new Error("missing winning claim");
      const counts = await inspection.db.execute(sql`
        select (select count(*)::int from app.accounts) as accounts,
          (select count(*)::int from app.identities) as identities,
          (select count(*)::int from app.credentials) as credentials,
          (select count(*)::int from app.sessions) as sessions,
          (select count(*)::int from app.providers) as providers
      `);
      expect(counts.rows[0]).toEqual({
        accounts: 1,
        identities: 1,
        credentials: 1,
        sessions: 1,
        providers: 1,
      });
      expect(claimed.status).toBe(200);
      const cookie = claimed.headers.get("set-cookie")?.split(";")[0];
      if (cookie === undefined) throw new Error("expected owner session cookie");
      expect(cookie).toContain("fdrive_session=");
    } finally {
      release();
      await composed.close();
      await inspection.close();
    }
  });
});
