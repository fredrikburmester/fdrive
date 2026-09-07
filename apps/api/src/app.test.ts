import { AboutResponse, HealthResponse } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp, isSetupExempt, redactMcpTokenPath, sftpgoHostLabel } from "./app";
import { loadConfig } from "./config";
import { ApiHttpError } from "./errors";

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

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  SFTPGO_URL: "http://localhost:8080",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

function createTestLogger(): Logger {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return logger as unknown as Logger;
}

const START = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-01T00:00:05.000Z");

function buildApp(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const logger = createTestLogger();
  const config = loadConfig(REQUIRED_ENV);
  const app = createApp({
    config,
    logger,
    version: "1.2.3",
    startedAt: START,
    clock: () => LATER,
    ...overrides,
  });
  return { app, logger };
}

describe("createApp health route", () => {
  it("uses the real clock when none is supplied", async () => {
    const logger = createTestLogger();
    const config = loadConfig(REQUIRED_ENV);
    const app = createApp({
      config,
      logger,
      version: "1.2.3",
      startedAt: new Date(Date.now() - 1000),
    });

    const res = await app.request("/api/v1/health");
    const body = await res.json();
    const result = HealthResponse.safeParse(body);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.uptimeSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns a valid HealthResponse with 200", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    const result = HealthResponse.safeParse(body);
    expect(result.success).toBe(true);
    expect(body).toEqual({
      status: "ok",
      service: "fdrive-api",
      version: "1.2.3",
      uptimeSeconds: 5,
      subsystems: {
        core: { status: "configured", missing: [] },
        network: { status: "configured", missing: [] },
        shares: { status: "configured", missing: [] },
        index: {
          status: "not_configured",
          missing: ["FDRIVE_INDEX_ROOTS", "FDRIVE_INDEXER_URL"],
        },
        search: { status: "not_configured", missing: ["FDRIVE_EMBED_URL"] },
        imageSearch: { status: "not_configured", missing: ["FDRIVE_IMAGE_EMBED_URL"] },
        thumbnails: { status: "not_configured", missing: ["FDRIVE_THUMBS_DIR"] },
        ocr: { status: "not_configured", missing: ["FDRIVE_OCR_URL"] },
        office: {
          status: "not_configured",
          missing: [
            "FDRIVE_OFFICE_PRODUCT",
            "FDRIVE_OFFICE_URL",
            "FDRIVE_OFFICE_PUBLIC_URL",
            "FDRIVE_WOPI_URL",
          ],
        },
        trash: { status: "not_configured", missing: ["FDRIVE_SFTPGO_TRASH_PATH"] },
      },
    });
  });

  it("calls subsystemReachability with the config and reports a failed probe as unreachable", async () => {
    const logger = createTestLogger();
    const config = loadConfig(REQUIRED_ENV);
    const app = createApp({
      config,
      logger,
      version: "1.2.3",
      startedAt: START,
      clock: () => LATER,
      subsystemReachability: async (calledWith) => {
        expect(calledWith).toBe(config);
        return { index: false };
      },
    });

    const res = await app.request("/api/v1/health");
    const body = (await res.json()) as { subsystems: { index: { status: string } } };
    // "index" is not_configured in this base config, so a (nonsensical, but
    // possible) reachability result for it must not override that.
    expect(body.subsystems.index.status).toBe("not_configured");
  });

  it("logs a structured request completion line", async () => {
    const { app, logger } = buildApp();

    await app.request("/api/v1/health");

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/v1/health",
        status: 200,
        ms: expect.any(Number),
        requestId: expect.any(String),
      }),
      "request completed",
    );
  });
});

describe("redactMcpTokenPath", () => {
  it("redacts the token segment of an /mcp/t/:token path", () => {
    expect(redactMcpTokenPath("/mcp/t/super-secret-token")).toBe("/mcp/t/[redacted]");
  });

  it("redacts a sub-path under the token, keeping only the prefix", () => {
    expect(redactMcpTokenPath("/mcp/t/super-secret-token/extra")).toBe("/mcp/t/[redacted]");
  });

  it("leaves a path that is exactly the prefix with no token unchanged as redacted", () => {
    expect(redactMcpTokenPath("/mcp/t/")).toBe("/mcp/t/[redacted]");
  });

  it("leaves other paths unchanged", () => {
    expect(redactMcpTokenPath("/mcp")).toBe("/mcp");
    expect(redactMcpTokenPath("/api/v1/health")).toBe("/api/v1/health");
  });
});

describe("createApp request logging redacts the MCP token path", () => {
  it("logs /mcp/t/[redacted] instead of the raw token for an /mcp/t/:token request", async () => {
    const { app, logger } = buildApp();

    await app.request("/mcp/t/super-secret-token", { method: "DELETE" });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/mcp/t/[redacted]" }),
      "request completed",
    );
  });
});

describe("sftpgoHostLabel", () => {
  it("returns host and port for a URL with a non-default port", () => {
    expect(sftpgoHostLabel("http://127.0.0.1:58080")).toBe("127.0.0.1:58080");
  });

  it("drops the scheme, path, and credentials", () => {
    expect(sftpgoHostLabel("https://admin:secret@sftpgo.internal:9443/base")).toBe(
      "sftpgo.internal:9443",
    );
  });

  it("omits the port when it is the default for the scheme", () => {
    expect(sftpgoHostLabel("https://sftpgo.example.com")).toBe("sftpgo.example.com");
  });
});

describe("createApp about route", () => {
  it("returns the version and SFTPGo attribution, redacting the host for an anonymous caller", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/about");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(AboutResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      version: "1.2.3",
      builtOn: { name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" },
      provider: { type: "sftpgo", label: null },
      setupRequired: false,
    });
  });

  it("reveals the SFTPGo host's label once the caller has a resolvable session", async () => {
    const { app } = buildApp({
      principalResolver: async () => ({
        accountId: "account-1",
        identityId: "identity-1",
        username: "alice",
        storage: FAKE_STORAGE,
        isAdmin: false,
      }),
    });

    const res = await app.request("/api/v1/about");
    const body = await res.json();

    expect(body).toMatchObject({ provider: { type: "sftpgo", label: "localhost:8080" } });
  });

  it("derives the provider label from the SFTPGo URL's host, dropping scheme and path, for an authenticated caller", async () => {
    const { app } = buildApp({
      config: loadConfig({ ...REQUIRED_ENV, SFTPGO_URL: "https://sftpgo.internal:9443/base" }),
      principalResolver: async () => ({
        accountId: "account-1",
        identityId: "identity-1",
        username: "alice",
        storage: FAKE_STORAGE,
        isAdmin: false,
      }),
    });

    const res = await app.request("/api/v1/about");
    const body = await res.json();

    expect(body).toMatchObject({ provider: { type: "sftpgo", label: "sftpgo.internal:9443" } });
  });

  it("keeps the label redacted for an anonymous caller even with a custom SFTPGo host", async () => {
    const { app } = buildApp({
      config: loadConfig({ ...REQUIRED_ENV, SFTPGO_URL: "https://sftpgo.internal:9443/base" }),
    });

    const res = await app.request("/api/v1/about");
    const body = await res.json();

    expect(body).toMatchObject({ provider: { type: "sftpgo", label: null } });
  });

  it("reports setupRequired and a null provider when connectionStatus says so", async () => {
    const { app } = buildApp({
      connectionStatus: async () => ({ required: true, host: null }),
    });

    const res = await app.request("/api/v1/about");
    const body = await res.json();

    expect(AboutResponse.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ provider: null, setupRequired: true });
  });

  it("defaults to setupRequired when config.sftpgoUrl is undefined and no connectionStatus is given", async () => {
    const { SFTPGO_URL: _drop, ...envWithoutSftpgo } = REQUIRED_ENV;
    const { app } = buildApp({ config: loadConfig(envWithoutSftpgo) });

    const res = await app.request("/api/v1/about");
    const body = await res.json();

    expect(body).toMatchObject({ provider: null, setupRequired: true });
  });
});

describe("isSetupExempt", () => {
  it("exempts health, about, and every setup route", () => {
    expect(isSetupExempt("/api/v1/health")).toBe(true);
    expect(isSetupExempt("/api/v1/about")).toBe(true);
    expect(isSetupExempt("/api/v1/setup/status")).toBe(true);
    expect(isSetupExempt("/api/v1/setup/test")).toBe(true);
  });

  it("does not exempt other routes", () => {
    expect(isSetupExempt("/api/v1/auth/login")).toBe(false);
    expect(isSetupExempt("/api/v1/fs/list")).toBe(false);
  });
});

describe("createApp setup gate", () => {
  it("responds 503 setup_required for a non-exempt route while setup is required", async () => {
    const { app } = buildApp({
      connectionStatus: async () => ({ required: true, host: null }),
      registerRoutes: ({ public: pub }) => {
        pub.get("/ping", (c) => c.json({ ok: true }));
      },
    });

    const res = await app.request("/api/v1/ping");

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ error: { kind: "setup_required" } });
  });

  it("still serves health and about while setup is required", async () => {
    const { app } = buildApp({ connectionStatus: async () => ({ required: true, host: null }) });

    expect((await app.request("/api/v1/health")).status).toBe(200);
    expect((await app.request("/api/v1/about")).status).toBe(200);
  });

  it("serves non-exempt routes normally once setup is not required", async () => {
    const { app } = buildApp({
      connectionStatus: async () => ({ required: false, host: "sftpgo:8080" }),
      registerRoutes: ({ public: pub }) => {
        pub.get("/ping", (c) => c.json({ ok: true }));
      },
    });

    const res = await app.request("/api/v1/ping");

    expect(res.status).toBe(200);
  });
});

describe("createApp request id handling", () => {
  it("echoes an incoming x-request-id header", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/health", {
      headers: { "x-request-id": "incoming-id-1" },
    });

    expect(res.headers.get("x-request-id")).toBe("incoming-id-1");
  });

  it("generates a request id when none is supplied", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/health");

    expect(res.headers.get("x-request-id")).toEqual(expect.any(String));
    expect(res.headers.get("x-request-id")?.length).toBeGreaterThan(0);
  });
});

describe("createApp not found handler", () => {
  it("returns the ApiError contract shape with 404 for a path outside /api/v1", async () => {
    const { app } = buildApp();

    const res = await app.request("/does-not-exist");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body).toMatchObject({
      error: {
        kind: "not_found",
        message: expect.stringContaining("/does-not-exist"),
      },
    });
  });

  it("returns unauthorized (not not-found) for an unregistered /api/v1 path, by default-deny", async () => {
    // Every /api/v1 route is either explicitly public (registered on the
    // `public` group, like /health and /about) or lives behind the `authed`
    // group's blanket createRequireAuth. An unregistered path under
    // /api/v1 therefore reads as "authentication required", not "not
    // found": the API never reveals route existence to an unauthenticated
    // caller.
    const { app } = buildApp();

    const res = await app.request("/api/v1/does-not-exist");
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body).toMatchObject({ error: { kind: "unauthorized" } });
  });
});

describe("createApp error handler", () => {
  it("maps a thrown ApiHttpError to its contract shape and status", async () => {
    const { app } = buildApp({
      registerRoutes: ({ public: v1 }) => {
        v1.get("/boom", () => {
          throw new ApiHttpError("conflict", "already exists", { path: "/a" });
        });
      },
    });

    const res = await app.request("/api/v1/boom");
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body).toEqual({
      error: {
        kind: "conflict",
        message: "already exists",
        requestId: expect.any(String),
        details: { path: "/a" },
      },
    });
  });

  it("maps an unknown thrown error to a hidden internal message and logs it", async () => {
    const { app, logger } = buildApp({
      registerRoutes: ({ public: v1 }) => {
        v1.get("/boom", () => {
          throw new Error("raw secret detail");
        });
      },
    });

    const res = await app.request("/api/v1/boom");
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({
      error: {
        kind: "internal",
        message: "internal server error",
        requestId: expect.any(String),
      },
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: expect.any(String) }),
      "unhandled error",
    );
  });
});

describe("createApp csrf guard wiring", () => {
  it("rejects a cross-site POST to a public route with 403", async () => {
    const { app } = buildApp({
      registerRoutes: ({ public: v1 }) => {
        v1.post("/echo", (c) => c.json({ ok: true }));
      },
    });

    const res = await app.request("/api/v1/echo", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ error: { kind: "forbidden" } });
  });

  it("allows a same-origin POST with the requested-with header through", async () => {
    const { app } = buildApp({
      registerRoutes: ({ public: v1 }) => {
        v1.post("/echo", (c) => c.json({ ok: true }));
      },
    });

    const res = await app.request("/api/v1/echo", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(200);
  });
});

describe("createApp authed group wiring", () => {
  it("returns unauthorized when the default principal resolver runs (no resolver configured)", async () => {
    const { app } = buildApp({
      registerRoutes: ({ authed }) => {
        authed.get("/whoami", (c) => c.json({ username: c.get("principal").username }));
      },
    });

    const res = await app.request("/api/v1/whoami");

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: { kind: "unauthorized" } });
  });

  it("sets the principal and serves the route when a resolver is configured", async () => {
    const { app } = buildApp({
      principalResolver: async () => ({
        accountId: "account-1",
        identityId: "identity-1",
        username: "alice",
        storage: FAKE_STORAGE,
        isAdmin: false,
      }),
      registerRoutes: ({ authed }) => {
        authed.get("/whoami", (c) => c.json({ username: c.get("principal").username }));
      },
    });

    const res = await app.request("/api/v1/whoami");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "alice" });
  });
});
