import { type SftpgoContainer, startPostgres, startSftpgo } from "@fdrive/testkit";
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

  it("keeps a failed owner login resumable, binds the real candidate, and reads a redacted admin inventory", async () => {
    if (postgres === undefined || sftpgo === undefined)
      throw new Error("test fixtures did not start");
    const { logger, messages } = capturingLogger();
    const config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 91).toString("base64"),
    });
    const composed = await composeApp(config, logger);

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

      const claimed = await composed.app.request("/api/v1/setup/complete", {
        method: "POST",
        headers: setupHeaders(token),
        body: JSON.stringify({
          baseUrl: sftpgo.baseUrl,
          homeTemplate: "sftpgo:/{username}",
          username: "alice",
          password: "alice-pass",
        }),
      });
      expect(claimed.status).toBe(200);
      const cookie = claimed.headers.get("set-cookie")?.split(";")[0];
      if (cookie === undefined) throw new Error("expected owner session cookie");

      const inventory = await composed.app.request("/api/v1/admin/connection/users", {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "fdrive", cookie },
        body: JSON.stringify({
          username: "admin",
          password: "admin-password-for-tests",
          limit: 10,
        }),
      });
      expect(inventory.status).toBe(200);
      expect(await inventory.json()).toEqual({
        ok: true,
        users: [
          { username: "alice", status: "enabled" },
          { username: "bob", status: "enabled" },
        ],
        nextOffset: null,
      });
    } finally {
      await composed.close();
    }
  });
});
