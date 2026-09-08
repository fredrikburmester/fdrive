import type { StorageProvider } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import type { Connection, ConnectionStore } from "../connection/store.js";
import { registerAdminRoutes } from "./routes.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
};

function notImplemented(): never {
  throw new Error("not implemented in this fake");
}

const FAKE_STORAGE: StorageProvider = {
  list: notImplemented,
  statFile: notImplemented,
  download: notImplemented,
  upload: notImplemented,
  mkdir: notImplemented,
  move: notImplemented,
  copy: notImplemented,
  deleteFile: notImplemented,
  deleteDir: notImplemented,
  setModifiedAt: notImplemented,
  zip: notImplemented,
};

function buildStore(connection: Connection | null): ConnectionStore {
  return {
    current: vi.fn().mockResolvedValue(connection),
    update: vi.fn().mockImplementation(async (patch) => ({
      baseUrl: patch.baseUrl ?? connection?.baseUrl ?? "http://sftpgo:8080",
      homeTemplate: patch.homeTemplate ?? connection?.homeTemplate ?? "sftpgo:/{username}",
      source: connection?.source ?? "settings",
    })),
  };
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

function twoStepProbeFetch(): typeof globalThis.fetch {
  return vi.fn(async (url: unknown) => {
    if (typeof url === "string" && url.endsWith("/healthz")) {
      return textResponse(200, "ok");
    }
    return textResponse(401, "unauthorized");
  }) as unknown as typeof globalThis.fetch;
}

function buildApp(opts: {
  connection: Connection | null;
  isAdmin: boolean;
  fetchImpl?: typeof globalThis.fetch;
}) {
  const config = loadConfig(REQUIRED_ENV);
  const store = buildStore(opts.connection);
  const fetchImpl = opts.fetchImpl ?? twoStepProbeFetch();
  const principal: Principal = {
    accountId: "account-1",
    identityId: "identity-1",
    username: "alice",
    storage: FAKE_STORAGE,
    isAdmin: opts.isAdmin,
  };

  const app = createApp({
    config,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    } as never,
    version: "1.0.0",
    startedAt: new Date(0),
    connectionStatus: async () => ({ required: false, host: "sftpgo:8080" }),
    principalResolver: async () => principal,
    registerRoutes: (groups) => {
      registerAdminRoutes(groups, {
        connectionStore: store,
        fetch: fetchImpl,
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
      });
    },
  });

  return { app, store, fetchImpl };
}

const ENV_CONNECTION: Connection = {
  baseUrl: "http://sftpgo:8080",
  homeTemplate: "sftpgo:/{username}",
  source: "env",
};

const SETTINGS_CONNECTION: Connection = {
  baseUrl: "http://sftpgo:8080",
  homeTemplate: "sftpgo:/{username}",
  source: "settings",
};

describe("admin routes: GET /admin/connection", () => {
  it("403s for a non-admin principal", async () => {
    const { app } = buildApp({ connection: ENV_CONNECTION, isAdmin: false });

    const res = await app.request("/api/v1/admin/connection");

    expect(res.status).toBe(403);
  });

  it("returns the connection summary for an admin", async () => {
    const { app } = buildApp({ connection: ENV_CONNECTION, isAdmin: true });

    const res = await app.request("/api/v1/admin/connection");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      baseUrl: "http://sftpgo:8080",
      host: "sftpgo:8080",
      homeTemplate: "sftpgo:/{username}",
      source: "env",
      reachable: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("reports reachable false when the probe fails", async () => {
    const { app } = buildApp({
      connection: ENV_CONNECTION,
      isAdmin: true,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(textResponse(500, "boom")) as unknown as typeof globalThis.fetch,
    });

    const res = await app.request("/api/v1/admin/connection");
    const body = (await res.json()) as { reachable: boolean };

    expect(body.reachable).toBe(false);
  });
});

describe("admin routes: PUT /admin/connection", () => {
  it("403s for a non-admin principal", async () => {
    const { app } = buildApp({ connection: SETTINGS_CONNECTION, isAdmin: false });

    const res = await app.request("/api/v1/admin/connection", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ homeTemplate: "sftpgo:/new/{username}" }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects an invalid home template", async () => {
    const { app } = buildApp({ connection: SETTINGS_CONNECTION, isAdmin: true });

    const res = await app.request("/api/v1/admin/connection", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ homeTemplate: "not-a-template" }),
    });

    expect(res.status).toBe(400);
  });

  it("updates the home template", async () => {
    const { app, store } = buildApp({ connection: SETTINGS_CONNECTION, isAdmin: true });

    const res = await app.request("/api/v1/admin/connection", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ homeTemplate: "sftpgo:/new/{username}" }),
    });

    expect(res.status).toBe(200);
    expect(store.update).toHaveBeenCalledWith({ homeTemplate: "sftpgo:/new/{username}" });
  });

  it("probes a candidate baseUrl before storing it, and rejects when unreachable", async () => {
    const { app, store } = buildApp({
      connection: SETTINGS_CONNECTION,
      isAdmin: true,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(textResponse(500, "boom")) as unknown as typeof globalThis.fetch,
    });

    const res = await app.request("/api/v1/admin/connection", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ baseUrl: "http://other:8080" }),
    });

    expect(res.status).toBe(400);
    expect(store.update).not.toHaveBeenCalled();
  });

  it("updates baseUrl when the probe succeeds", async () => {
    const { app, store } = buildApp({ connection: SETTINGS_CONNECTION, isAdmin: true });

    const res = await app.request("/api/v1/admin/connection", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ baseUrl: "http://other:8080" }),
    });

    expect(res.status).toBe(200);
    expect(store.update).toHaveBeenCalledWith({ baseUrl: "http://other:8080" });
  });

  it("rejects an invalid request body", async () => {
    const { app } = buildApp({ connection: SETTINGS_CONNECTION, isAdmin: true });

    const res = await app.request("/api/v1/admin/connection", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ baseUrl: "not-a-url" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const { app } = buildApp({ connection: SETTINGS_CONNECTION, isAdmin: true });

    const res = await app.request("/api/v1/admin/connection", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });
});

describe("admin routes: POST /admin/connection/test", () => {
  it("403s for a non-admin principal", async () => {
    const { app } = buildApp({ connection: SETTINGS_CONNECTION, isAdmin: false });

    const res = await app.request("/api/v1/admin/connection/test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
  });

  it("probes the active connection when no baseUrl is given", async () => {
    const { app, fetchImpl } = buildApp({ connection: SETTINGS_CONNECTION, isAdmin: true });

    const res = await app.request("/api/v1/admin/connection/test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, detail: "SFTPGo is reachable" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://sftpgo:8080/healthz",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("probes a given candidate baseUrl", async () => {
    const { app, fetchImpl } = buildApp({ connection: SETTINGS_CONNECTION, isAdmin: true });

    const res = await app.request("/api/v1/admin/connection/test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ baseUrl: "http://other:8080" }),
    });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://other:8080/healthz",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("responds setup_required when no connection exists and no baseUrl is given", async () => {
    const { app } = buildApp({ connection: null, isAdmin: true });

    const res = await app.request("/api/v1/admin/connection/test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(503);
  });

  it("rejects an invalid request body", async () => {
    const { app } = buildApp({ connection: SETTINGS_CONNECTION, isAdmin: true });

    const res = await app.request("/api/v1/admin/connection/test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ baseUrl: "not-a-url" }),
    });

    expect(res.status).toBe(400);
  });

  it("defaults to an empty body when none is sent", async () => {
    const { app } = buildApp({ connection: SETTINGS_CONNECTION, isAdmin: true });

    const res = await app.request("/api/v1/admin/connection/test", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(200);
  });
});
