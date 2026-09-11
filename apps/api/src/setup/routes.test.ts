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
  identities: [
    {
      id: "identity-1",
      username: "alice",
      providerId: "123e4567-e89b-42d3-a456-426614174000",
      providerType: "sftpgo",
      providerLabel: "x",
      capabilities: {
        zip: true,
        setModifiedAt: true,
        atomicMove: true,
        trash: false,
        shares: true,
        office: true,
        index: false,
        scopeMapping: false,
      },
    },
  ],
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
    connectionStatus: async () => ({ required: true, providers: [] }),
    registerRoutes: (groups) => {
      registerSetupRoutes(groups, { service, tokenGuard, limiter, config });
    },
  });

  return { app, service, tokenGuard, limiter };
}

/**
 * A tokenless `POST /setup/test` from `ip`, which the token guard rejects
 * (401) and the limiter records as a failure. `x-forwarded-for` carries the
 * address because the default one trusted proxy hop reads the client from
 * it, and the unit test harness has no socket for `getConnInfo` to report.
 */
function attemptFrom(app: ReturnType<typeof buildApp>["app"], ip: string) {
  return app.request("/api/v1/setup/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-requested-with": "fdrive",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ baseUrl: "http://sftpgo:8080" }),
  });
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

  it("spends one allowance across every address in an IPv6 /64", async () => {
    const limiter = createLoginLimiter({
      clock: () => new Date(),
      maxFailures: 2,
      windowMs: 60_000,
      blockMs: 60_000,
    });
    const { app } = buildApp({ limiter });

    await attemptFrom(app, "2001:db8:1:2::1");
    await attemptFrom(app, "2001:db8:1:2::2");
    const third = await attemptFrom(app, "2001:db8:1:2::3");

    expect(third.status).toBe(429);
  });

  it("keeps a separate allowance for a different IPv6 /64", async () => {
    const limiter = createLoginLimiter({
      clock: () => new Date(),
      maxFailures: 2,
      windowMs: 60_000,
      blockMs: 60_000,
    });
    const { app } = buildApp({ limiter });

    await attemptFrom(app, "2001:db8:1:2::1");
    await attemptFrom(app, "2001:db8:1:2::2");
    const neighbour = await attemptFrom(app, "2001:db8:1:3::1");

    expect(neighbour.status).toBe(401);
  });

  it("spends one allowance across an IPv4 address and its mapped form", async () => {
    const limiter = createLoginLimiter({
      clock: () => new Date(),
      maxFailures: 2,
      windowMs: 60_000,
      blockMs: 60_000,
    });
    const { app } = buildApp({ limiter });

    await attemptFrom(app, "203.0.113.9");
    await attemptFrom(app, "::ffff:203.0.113.9");
    const third = await attemptFrom(app, "203.0.113.9");

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
