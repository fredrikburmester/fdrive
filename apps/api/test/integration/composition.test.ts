import { createDb } from "@fdrive/db";
import { createFakeSftpgoServer } from "@fdrive/sftpgo";
import { SEED_FILES, SEED_FOLDERS, SEED_USERS, startPostgres } from "@fdrive/testkit";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";

function createTestLogger(): Logger {
  const noop = () => undefined;
  return {
    info: noop,
    error: noop,
    warn: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
  } as unknown as Logger;
}

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (setCookie === null) {
    throw new Error("expected a Set-Cookie header");
  }
  const cookiePair = setCookie.split(";")[0];
  if (cookiePair === undefined) {
    throw new Error("malformed Set-Cookie header");
  }
  return cookiePair;
}

/** Reads and decodes the first chunk written to an SSE response body. */
async function readFirstSseChunk(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  try {
    const { value, done } = await reader.read();
    if (done || value === undefined) {
      throw new Error("expected at least one SSE chunk");
    }
    return new TextDecoder().decode(value);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

describe("composeApp", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;

  beforeAll(async () => {
    postgres = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    await postgres.stop();
  }, 180_000);

  it("migrates the database, logs in, lists seeded files, and streams a ping", async () => {
    const server = createFakeSftpgoServer({
      users: [...SEED_USERS],
      folders: [...SEED_FOLDERS],
      files: { ...SEED_FILES },
    });

    const config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      SFTPGO_URL: "http://sftpgo.internal:8080",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
    });

    const composed = await composeApp(config, createTestLogger(), () => new Date(), {
      fetch: server.fetch,
    });

    try {
      // Migrations ran: the app schema's `providers` table exists.
      const { db, close } = createDb(postgres.connectionString);
      try {
        const result = await db.execute(sql`
          select 1
          from information_schema.tables
          where table_schema = 'app' and table_name = 'providers'
        `);
        expect(result.rows).toHaveLength(1);
      } finally {
        await close();
      }

      const loginRes = await composed.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-requested-with": "fdrive",
        },
        body: JSON.stringify({ username: "alice", password: "alice-password" }),
      });
      expect(loginRes.status).toBe(200);
      const cookie = extractCookie(loginRes);

      const listRes = await composed.app.request("/api/v1/fs/list?path=/", {
        headers: { cookie },
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { entries: { name: string }[] };
      const names = listBody.entries.map((entry) => entry.name).sort();
      expect(names).toEqual(["docs", "photo.jpg"]);

      const eventsController = new AbortController();
      const eventsRes = await composed.app.request("/api/v1/events", {
        headers: { cookie },
        signal: eventsController.signal,
      });
      expect(eventsRes.status).toBe(200);
      if (eventsRes.body === null) {
        throw new Error("expected a streamed response body");
      }
      const firstChunk = await readFirstSseChunk(eventsRes.body);
      expect(firstChunk).toContain("event: ping");
      // Aborting lets the route's own cleanup (clearing its ping interval and
      // unsubscribing from the bus) run, rather than leaking a timer.
      eventsController.abort();
    } finally {
      await composed.close();
    }
  });
});
