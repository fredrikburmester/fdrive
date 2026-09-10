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

/** A logger that records every string passed to `info` or `warn`, so a test can recover the logged setup token. */
function createCapturingLogger(): { logger: Logger; messages: string[] } {
  const messages: string[] = [];
  const record = (arg: unknown) => {
    if (typeof arg === "string") {
      messages.push(arg);
    }
  };
  const logger = {
    info: record,
    error: () => undefined,
    warn: record,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
  } as unknown as Logger;
  return { logger, messages };
}

/**
 * Wraps a fetch implementation (typically a fake SFTPGo server's `fetch`)
 * with a `/healthz` handler returning `200 "ok"`, since the fake does not
 * implement it and `probeConnection` requires it.
 */
function withHealthz(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/healthz")) {
      return new Response("ok", { status: 200 });
    }
    return fetchImpl(input, init);
  }) as typeof globalThis.fetch;
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
        body: JSON.stringify({ credential: { username: "alice", password: "alice-password" } }),
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

  it("boots in setup mode, walks the setup flow, then serves normal routes with the completing account as admin", async () => {
    const server = createFakeSftpgoServer({
      users: [...SEED_USERS],
      folders: [...SEED_FOLDERS],
      files: { ...SEED_FILES },
    });
    const fetchImpl = withHealthz(server.fetch);

    // No SFTPGO_URL and a database no earlier test seeded a provider into:
    // the provider must come from `/setup`. Providers are rows now, so the
    // env-seeded row of the previous test would otherwise count as set up.
    const ownPostgres = await startPostgres();
    const config = loadConfig({
      DATABASE_URL: ownPostgres.connectionString,
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 6).toString("base64"),
    });

    const { logger, messages } = createCapturingLogger();
    const composed = await composeApp(config, logger, () => new Date(), { fetch: fetchImpl });

    try {
      const aboutRes = await composed.app.request("/api/v1/about");
      expect(aboutRes.status).toBe(200);
      expect(await aboutRes.json()).toMatchObject({ setupRequired: true, providers: [] });

      const blockedRes = await composed.app.request("/api/v1/fs/list?path=/");
      expect(blockedRes.status).toBe(503);
      expect(await blockedRes.json()).toMatchObject({ error: { kind: "setup_required" } });

      const statusRes = await composed.app.request("/api/v1/setup/status");
      expect(await statusRes.json()).toEqual({ required: true, hasEnvUrl: false });

      const tokenLine = messages.find((message) => message.startsWith("setup token: "));
      if (tokenLine === undefined) {
        throw new Error("expected the setup token to be logged");
      }
      const setupToken = tokenLine.slice("setup token: ".length);

      const testRes = await composed.app.request("/api/v1/setup/test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-requested-with": "fdrive",
          "x-setup-token": setupToken,
        },
        body: JSON.stringify({ baseUrl: "http://sftpgo.internal:8080" }),
      });
      expect(testRes.status).toBe(200);
      expect(await testRes.json()).toMatchObject({ ok: true });

      const completeRes = await composed.app.request("/api/v1/setup/complete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-requested-with": "fdrive",
          "x-setup-token": setupToken,
        },
        body: JSON.stringify({
          baseUrl: "http://sftpgo.internal:8080",
          homeTemplate: "sftpgo:/{username}",
          username: "alice",
          password: "alice-password",
        }),
      });
      expect(completeRes.status).toBe(200);
      const completeBody = await completeRes.json();
      expect(completeBody).toMatchObject({
        isAdmin: true,
        account: { displayName: "alice" },
      });
      const cookie = extractCookie(completeRes);

      // The setup token cannot be replayed: setup is no longer required.
      const reuseRes = await composed.app.request("/api/v1/setup/test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-requested-with": "fdrive",
          "x-setup-token": setupToken,
        },
        body: JSON.stringify({ baseUrl: "http://sftpgo.internal:8080" }),
      });
      expect(reuseRes.status).toBe(404);

      const aboutAfterRes = await composed.app.request("/api/v1/about");
      expect(await aboutAfterRes.json()).toMatchObject({
        setupRequired: false,
        providers: [{ type: "sftpgo" }],
      });

      const listRes = await composed.app.request("/api/v1/fs/list?path=/", {
        headers: { cookie },
      });
      expect(listRes.status).toBe(200);

      const meRes = await composed.app.request("/api/v1/auth/me", { headers: { cookie } });
      expect(meRes.status).toBe(200);
      expect(await meRes.json()).toMatchObject({ isAdmin: true });
    } finally {
      await composed.close();
      await ownPostgres.stop();
    }
  });

  it("logs a startup summary line per subsystem and serves GET /api/v1/health with a matching subsystems field", async () => {
    const server = createFakeSftpgoServer({
      users: [...SEED_USERS],
      folders: [...SEED_FOLDERS],
      files: { ...SEED_FILES },
    });

    const config = loadConfig({
      DATABASE_URL: postgres.connectionString,
      SFTPGO_URL: "http://sftpgo.internal:8080",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
      // Left unconfigured: index, search, ocr, thumbnails, office, trash.
    });

    const { logger, messages } = createCapturingLogger();
    const composed = await composeApp(config, logger, () => new Date(), { fetch: server.fetch });

    try {
      expect(messages).toContain("subsystem=core status=configured");
      expect(messages).toContain(
        "subsystem=index status=not configured missing=FDRIVE_INDEX_ROOTS,FDRIVE_INDEXER_URL",
      );
      expect(messages).toContain("subsystem=search status=not configured missing=FDRIVE_EMBED_URL");
      expect(messages.some((message) => message.startsWith("subsystem=network bind hint"))).toBe(
        true,
      );

      const healthRes = await composed.app.request("/api/v1/health");
      expect(healthRes.status).toBe(200);
      const body = (await healthRes.json()) as {
        subsystems: Record<string, { status: string; missing: string[] }>;
      };
      expect(body.subsystems.core).toEqual({ status: "configured", missing: [] });
      expect(body.subsystems.index).toEqual({
        status: "not_configured",
        missing: ["FDRIVE_INDEX_ROOTS", "FDRIVE_INDEXER_URL"],
      });
      expect(body.subsystems.ocr).toEqual({
        status: "not_configured",
        missing: ["FDRIVE_OCR_URL"],
      });
    } finally {
      await composed.close();
    }
  });
});
