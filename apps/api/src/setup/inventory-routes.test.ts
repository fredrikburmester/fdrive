import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createLoginLimiter } from "../auth/login-limiter.js";
import { loadConfig } from "../config.js";
import type { ConnectionStore } from "../connection/store.js";
import { registerSetupInventoryRoutes, SETUP_INVENTORY_PATH } from "./inventory-routes.js";

const config = loadConfig({
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
});

function build(
  connection: ConnectionStore | null,
  isAdmin: boolean,
  fetch: typeof globalThis.fetch = vi.fn(),
) {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  const app = createApp({
    config,
    logger: logger as never,
    version: "test",
    startedAt: new Date(),
    connectionStatus: async () => ({ required: false, host: "sftpgo:8080" }),
    principalResolver: async () => ({
      accountId: "account",
      identityId: "identity",
      username: "owner",
      storage: {} as never,
      isAdmin,
    }),
    registerRoutes(groups) {
      registerSetupInventoryRoutes(groups, {
        connectionStore:
          connection ??
          ({ current: vi.fn().mockResolvedValue(null), update: vi.fn() } satisfies ConnectionStore),
        fetch,
        limiter: createLoginLimiter({ clock: () => new Date() }),
        config,
      });
    },
  });
  return { app, logger };
}

const BODY = JSON.stringify({ username: "admin", password: "secret" });
const headers = { "content-type": "application/json", "x-requested-with": "fdrive" };
const ACTIVE_CONNECTION: ConnectionStore = {
  current: vi.fn().mockResolvedValue({
    baseUrl: "http://sftpgo:8080",
    homeTemplate: "sftpgo:/{username}",
    source: "settings",
  }),
  update: vi.fn(),
};

describe("setup inventory route", () => {
  it("requires the claimed server owner", async () => {
    const { app } = build(null, false);
    const response = await app.request(SETUP_INVENTORY_PATH, {
      method: "POST",
      body: BODY,
      headers,
    });

    expect(response.status).toBe(403);
  });

  it("does not accept inventory without an active provider", async () => {
    const { app, logger } = build(null, true);
    const response = await app.request(SETUP_INVENTORY_PATH, {
      method: "POST",
      body: BODY,
      headers,
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(await response.text()).toContain("setup_required");
  });

  it("returns only the redacted inventory projection for an admin", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "admin-token" })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ username: "alice", status: 1, home_dir: "/secret" }])),
      );
    const { app } = build(ACTIVE_CONNECTION, true, fetch);

    const response = await app.request(SETUP_INVENTORY_PATH, {
      method: "POST",
      body: BODY,
      headers,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      users: [{ username: "alice", status: "enabled" }],
      nextOffset: null,
    });
  });

  it("rate limits repeated denied administrator credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("denied", { status: 403 }));
    const { app } = build(ACTIVE_CONNECTION, true, fetch);

    for (let count = 0; count < 5; count += 1) {
      const response = await app.request(SETUP_INVENTORY_PATH, {
        method: "POST",
        body: BODY,
        headers,
      });
      expect(await response.json()).toEqual({ ok: false, reason: "denied" });
    }
    const limited = await app.request(SETUP_INVENTORY_PATH, {
      method: "POST",
      body: BODY,
      headers,
    });
    expect(limited.status).toBe(429);
  });
});
