import type { MeResponse } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createLoginLimiter, type LoginLimiter } from "../auth/login-limiter.js";
import { loadConfig } from "../config.js";
import { registerSetupRoutes } from "./routes.js";
import type { SetupService } from "./service.js";
import { createSetupTokenGuard, type SetupTokenGuard } from "./token.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
};

const ME: MeResponse = {
  account: { id: "account-1", displayName: "alice" },
  identities: [{ id: "identity-1", username: "alice", providerType: "sftpgo", providerLabel: "x" }],
  activeIdentityId: "identity-1",
  isAdmin: true,
};

function buildService(overrides: Partial<SetupService> = {}): SetupService {
  return {
    status: vi.fn().mockResolvedValue({ required: true, hasEnvUrl: false }),
    test: vi.fn().mockResolvedValue({ ok: true, detail: "SFTPGo is reachable" }),
    complete: vi.fn().mockResolvedValue({ sessionId: "session-1", me: ME }),
    ...overrides,
  };
}

function buildApp(
  opts: { service?: SetupService; tokenGuard?: SetupTokenGuard; limiter?: LoginLimiter } = {},
) {
  const config = loadConfig(REQUIRED_ENV);
  const service = opts.service ?? buildService();
  const tokenGuard = opts.tokenGuard ?? createSetupTokenGuard("correct-token");
  const limiter = opts.limiter ?? createLoginLimiter({ clock: () => new Date() });

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
    connectionStatus: async () => ({ required: true, host: null }),
    registerRoutes: (groups) => {
      registerSetupRoutes(groups, { service, tokenGuard, limiter, config });
    },
  });

  return { app, service, tokenGuard, limiter };
}

describe("setup routes: GET /setup/status", () => {
  it("returns the service's status", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/setup/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: true, hasEnvUrl: false });
  });
});

describe("setup routes: POST /setup/test", () => {
  it("returns 404 once setup is no longer required", async () => {
    const { app } = buildApp({
      service: buildService({
        status: vi.fn().mockResolvedValue({ required: false, hasEnvUrl: false }),
      }),
    });

    const res = await app.request("/api/v1/setup/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fdrive",
        "x-setup-token": "correct-token",
      },
      body: JSON.stringify({ baseUrl: "http://sftpgo:8080" }),
    });

    expect(res.status).toBe(404);
  });

  it("rejects a missing or wrong setup token", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/setup/test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ baseUrl: "http://sftpgo:8080" }),
    });

    expect(res.status).toBe(401);
  });

  it("rejects an invalid body", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/setup/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fdrive",
        "x-setup-token": "correct-token",
      },
      body: JSON.stringify({ baseUrl: "not-a-url" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/setup/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fdrive",
        "x-setup-token": "correct-token",
      },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  it("succeeds with a correct token and valid body", async () => {
    const { app, service } = buildApp();

    const res = await app.request("/api/v1/setup/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fdrive",
        "x-setup-token": "correct-token",
      },
      body: JSON.stringify({ baseUrl: "http://sftpgo:8080" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, detail: "SFTPGo is reachable" });
    expect(service.test).toHaveBeenCalledWith("http://sftpgo:8080");
  });

  it("rate limits repeated failures from the same ip", async () => {
    const limiter = createLoginLimiter({
      clock: () => new Date(),
      maxFailures: 2,
      windowMs: 60_000,
      blockMs: 60_000,
    });
    const { app } = buildApp({ limiter });
    const attempt = () =>
      app.request("/api/v1/setup/test", {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
        body: JSON.stringify({ baseUrl: "http://sftpgo:8080" }),
      });

    await attempt();
    await attempt();
    const third = await attempt();

    expect(third.status).toBe(429);
  });
});

describe("setup routes: POST /setup/complete", () => {
  const validBody = {
    baseUrl: "http://sftpgo:8080",
    homeTemplate: "sftpgo:/{username}",
    username: "alice",
    password: "hunter2",
  };

  function postComplete(
    app: ReturnType<typeof buildApp>["app"],
    body: Record<string, unknown> = validBody,
    token = "correct-token",
  ) {
    return app.request("/api/v1/setup/complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fdrive",
        "x-setup-token": token,
      },
      body: JSON.stringify(body),
    });
  }

  it("returns 404 once setup is no longer required", async () => {
    const { app } = buildApp({
      service: buildService({
        status: vi.fn().mockResolvedValue({ required: false, hasEnvUrl: false }),
      }),
    });

    expect((await postComplete(app)).status).toBe(404);
  });

  it("rejects a missing or wrong setup token", async () => {
    const { app } = buildApp();

    expect((await postComplete(app, validBody, "wrong")).status).toBe(401);
  });

  it("rejects an invalid body", async () => {
    const { app } = buildApp();

    expect((await postComplete(app, { ...validBody, username: "" })).status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/setup/complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fdrive",
        "x-setup-token": "correct-token",
      },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  it("succeeds, sets the session cookie, and invalidates the token", async () => {
    const { app, tokenGuard } = buildApp();

    const res = await postComplete(app);

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("fdrive_session=");
    expect(tokenGuard.verify("correct-token")).toBe(false);
    expect(await res.json()).toEqual(ME);
  });

  it("records a limiter failure and does not invalidate the token when complete rejects", async () => {
    const service = buildService({ complete: vi.fn().mockRejectedValue(new Error("boom")) });
    const { app, tokenGuard } = buildApp({ service });

    const res = await postComplete(app);

    expect(res.status).toBe(500);
    expect(tokenGuard.verify("correct-token")).toBe(true);
  });
});
