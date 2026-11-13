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
      providerType: "local",
      providerLabel: "x",
      capabilities: {
        zip: true,
        setModifiedAt: true,
        atomicMove: true,
        trash: false,
        shares: true,
        office: true,
        index: false,
        shareWithPeople: true,
      },
    },
  ],
  activeIdentityId: "identity-1",
  isAdmin: true,
};

function buildService(overrides: Partial<SetupService> = {}): SetupService {
  return {
    status: vi.fn().mockResolvedValue({ required: true, storageConfigured: true }),
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
 * A tokenless `POST /setup/complete` from `ip`, which the token guard rejects
 * (401) and the limiter records as a failure. `x-forwarded-for` carries the
 * address because the default one trusted proxy hop reads the client from
 * it, and the unit test harness has no socket for `getConnInfo` to report.
 */
function attemptFrom(app: ReturnType<typeof buildApp>["app"], ip: string) {
  return app.request("/api/v1/setup/complete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-requested-with": "fdrive",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ username: "alice", password: "correct horse" }),
  });
}

describe("setup routes: GET /setup/status", () => {
  it("returns the service's status", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/setup/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: true, storageConfigured: true });
  });
});

describe("setup routes: rate limiting", () => {
  it("rate limits repeated failures from the same ip", async () => {
    const limiter = createLoginLimiter({
      clock: () => new Date(),
      maxFailures: 2,
      windowMs: 60_000,
      blockMs: 60_000,
    });
    const { app } = buildApp({ limiter });
    const attempt = () =>
      app.request("/api/v1/setup/complete", {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
        body: JSON.stringify({ username: "alice", password: "correct horse" }),
      });

    await attempt();
    await attempt();
    const third = await attempt();

    expect(third.status).toBe(429);
  });

  it("answers a blocked address without a retry hint as retry now", async () => {
    const limiter = createLoginLimiter({ clock: () => new Date() });
    vi.spyOn(limiter, "check").mockReturnValue({ allowed: false });
    const { app } = buildApp({ limiter });
    const res = await app.request("/api/v1/setup/complete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ username: "alice", password: "correct horse" }),
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: { kind: "rate_limited", details: { retryAfterMs: 0 } },
    });
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
  const validBody = { username: "alice", password: "correct horse" };

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
        status: vi.fn().mockResolvedValue({ required: false, storageConfigured: true }),
      }),
    });

    expect((await postComplete(app)).status).toBe(404);
  });

  it("rejects a missing or wrong setup token", async () => {
    const { app } = buildApp();

    expect((await postComplete(app, validBody, "wrong")).status).toBe(401);
  });

  it("rejects an invalid body, including the removed provider setup", async () => {
    const { app, service } = buildApp();
    for (const body of [
      { username: "", password: "correct horse" },
      { username: "alice", password: "x" },
      { ...validBody, kind: "local" },
      {
        kind: "provider",
        type: "webdav",
        baseUrl: "http://dav:8080",
        credential: { username: "alice", password: "hunter2" },
      },
    ]) {
      expect((await postComplete(app, body)).status).toBe(400);
    }
    expect(service.complete).not.toHaveBeenCalled();
  });

  it("forwards the first user to setup", async () => {
    const { app, service } = buildApp();
    expect((await postComplete(app, validBody)).status).toBe(200);
    expect(service.complete).toHaveBeenCalledWith(expect.objectContaining(validBody));
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
