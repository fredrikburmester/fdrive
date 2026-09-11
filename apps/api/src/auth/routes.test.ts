import { type ApiError, MeResponse, ROUTES } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Repos } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createFakeSftpgoServer, createSftpgoClient } from "@fdrive/sftpgo";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { memoryProviderService, seedSftpgoProvider } from "../providers/test-fixtures/index.ts";
import { parseMasterKey } from "./crypto";
import { createAuthModule } from "./index";
import { registerAuthRoutes } from "./routes";
import { memoryIdentityOperations } from "./test-fixtures/index.ts";

function notImplemented(): never {
  throw new Error("not implemented in this fake");
}

const FAKE_STORAGE: StorageProvider = {
  list: notImplemented,
  stat: notImplemented,
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

const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://localhost/fdrive",
  SFTPGO_URL: "http://sftpgo.internal:8080",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
  FDRIVE_SESSION_TTL_DAYS: "30",
  FDRIVE_COOKIE_SECURE: "auto",
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

function createClock(startMs: number) {
  let now = startMs;
  return {
    clock: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

function buildTestApp(opts: {
  clockCtl: ReturnType<typeof createClock>;
  envOverrides?: Record<string, string>;
  wrapFetch?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
}) {
  const server = createFakeSftpgoServer({
    users: [
      { username: "alice", password: "wonderland", permissions: { "/": ["*"] } },
      { username: "bob", password: "builder", permissions: { "/": ["*"] } },
    ],
    now: opts.clockCtl.clock,
  });
  const fetchImpl = opts.wrapFetch ? opts.wrapFetch(server.fetch) : server.fetch;
  const repos: Repos = createMemoryRepos();
  const config = loadConfig({ ...REQUIRED_ENV, ...opts.envOverrides });
  const providers = memoryProviderService(repos, {
    fetch: fetchImpl,
    clock: opts.clockCtl.clock,
    sftpgoUrl: config.sftpgoUrl,
  });
  // Memory repos settle in microtasks, well before the first request below.
  void seedSftpgoProvider(repos, "http://sftpgo.internal:8080", { managedByEnv: true });
  const authModule = createAuthModule({
    identityLinks: memoryIdentityOperations(repos),
    repos,
    providers,
    fetch: fetchImpl,
    master: parseMasterKey(config.fdriveMasterKey),
    clock: opts.clockCtl.clock,
    config,
    storageFactory: async () => FAKE_STORAGE,
  });
  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(0),
    clock: opts.clockCtl.clock,
    principalResolver: authModule.principalResolver,
    registerRoutes: authModule.registerRoutes,
  });

  return { app, repos, server, config, authModule, providers };
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
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

async function login(
  app: ReturnType<typeof buildTestApp>["app"],
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return app.request(ROUTES.auth.login, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-requested-with": "fdrive",
      ...extraHeaders,
    },
    body: JSON.stringify("credential" in body ? body : { credential: body }),
  });
}

describe("auth routes: POST /auth/login", () => {
  let clockCtl: ReturnType<typeof createClock>;

  beforeEach(() => {
    clockCtl = createClock(Date.now());
  });

  it("responds setup_required when no provider is configured", async () => {
    // Exercises the auth service in isolation from the app-level setup gate
    // (which derives its own status from `config.sftpgoUrl`, set in
    // `REQUIRED_ENV`): the auth service sees no provider rows at all.
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "wonderland", permissions: { "/": ["*"] } }],
      now: clockCtl.clock,
    });
    const repos: Repos = createMemoryRepos();
    const config = loadConfig(REQUIRED_ENV);
    const authModule = createAuthModule({
      identityLinks: memoryIdentityOperations(repos),
      repos,
      providers: memoryProviderService(repos, { fetch: server.fetch, clock: clockCtl.clock }),
      fetch: server.fetch,
      master: parseMasterKey(config.fdriveMasterKey),
      clock: clockCtl.clock,
      config,
      storageFactory: async () => FAKE_STORAGE,
    });
    const app = createApp({
      config,
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date(0),
      clock: clockCtl.clock,
      principalResolver: authModule.principalResolver,
      registerRoutes: authModule.registerRoutes,
    });

    const res = await login(app, { username: "alice", password: "wonderland" });

    expect(res.status).toBe(503);
  });

  it("binds a setup candidate login to its own provider row even while that row is disabled", async () => {
    const server = createFakeSftpgoServer({
      users: [{ username: "alice", password: "wonderland", permissions: { "/": ["*"] } }],
      now: clockCtl.clock,
    });
    const repos = createMemoryRepos();
    const config = loadConfig(REQUIRED_ENV);
    const requests: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (url, init) => {
      requests.push(new URL(String(url)).host);
      return server.fetch(url, init);
    };
    const active = await seedSftpgoProvider(repos, "http://active:8080", { managedByEnv: true });
    const candidate = await seedSftpgoProvider(repos, "http://candidate:8080", { enabled: false });
    const auth = createAuthModule({
      identityLinks: memoryIdentityOperations(repos),
      repos,
      providers: memoryProviderService(repos, { fetch: fetchImpl, clock: clockCtl.clock }),
      fetch: fetchImpl,
      master: parseMasterKey(config.fdriveMasterKey),
      clock: clockCtl.clock,
      config,
      storageFactory: async () => FAKE_STORAGE,
    });

    const result = await auth.service.loginCandidate(
      {
        credential: { username: "alice", password: "wonderland" },
        userAgent: null,
        ip: "127.0.0.1",
      },
      candidate.id,
    );
    const identity = await repos.identities.get(result.me.activeIdentityId);
    if (identity === null) throw new Error("expected candidate identity");

    expect(requests).toEqual(["candidate:8080"]);
    expect(identity.providerId).toBe(candidate.id);
    expect((await repos.providers.get(active.id))?.enabled).toBe(true);
    expect((await repos.providers.get(candidate.id))?.enabled).toBe(false);
  });

  it("succeeds with correct credentials, returns MeResponse, and sets a non-Secure cookie over plain http", async () => {
    const { app, server } = buildTestApp({ clockCtl });

    const res = await login(app, { username: "alice", password: "wonderland" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(MeResponse.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      account: { displayName: "alice" },
      identities: [{ username: "alice", providerType: "sftpgo" }],
    });

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("fdrive_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");

    // Exactly one SFTPGo login per fdrive login: `authService.login` primes
    // the token cache from its own `sftpgo.login` result rather than having
    // `tokenSource.get` mint a second token right after.
    expect(server.state.tokens.size).toBe(1);
  });

  it("rejects a non-canonical provider ID before repository access", async () => {
    const { app } = buildTestApp({ clockCtl });
    const res = await login(app, {
      providerId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
      credential: { username: "alice", password: "wonderland" },
    });

    expect(res.status).toBe(400);
    expect(await readJson<ApiError>(res)).toMatchObject({ error: { kind: "bad_request" } });
  });

  it("mints exactly one SFTPGo token per fdrive login, reused by the first authenticated request", async () => {
    const { app, server } = buildTestApp({ clockCtl });

    const loginRes = await login(app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(loginRes);
    expect(server.state.tokens.size).toBe(1);

    const meRes = await app.request(ROUTES.auth.me, { headers: { cookie } });
    expect(meRes.status).toBe(200);

    // `GET /auth/me` never touches storage, so it does not mint a token
    // either; the count stays at the one from login.
    expect(server.state.tokens.size).toBe(1);
  });

  it("sets a Secure cookie when the request arrived over a forwarded https connection", async () => {
    const { app } = buildTestApp({ clockCtl });

    const res = await login(
      app,
      { username: "alice", password: "wonderland" },
      { "x-forwarded-proto": "https" },
    );

    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("returns 401 unauthorized for a wrong password", async () => {
    const { app } = buildTestApp({ clockCtl });

    const res = await login(app, { username: "alice", password: "wrong-password" });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: { kind: "unauthorized" } });
  });

  it("returns 400 bad_request with zod issues for a malformed body", async () => {
    const { app } = buildTestApp({ clockCtl });

    const res = await login(app, { username: "" });

    expect(res.status).toBe(400);
    const body = await readJson<ApiError>(res);
    expect(body.error.kind).toBe("bad_request");
    expect(body.error.details?.issues).toEqual(expect.any(Array));
  });

  it("returns 400 bad_request for a body that is not valid JSON", async () => {
    const { app } = buildTestApp({ clockCtl });

    const res = await app.request(ROUTES.auth.login, {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: "not json at all",
    });

    expect(res.status).toBe(400);
    const body = await readJson<ApiError>(res);
    expect(body.error.kind).toBe("bad_request");
  });

  it("rate limits after 5 failed attempts from the same ip and username", async () => {
    const { app } = buildTestApp({ clockCtl });

    for (let i = 0; i < 5; i += 1) {
      const res = await login(app, { username: "alice", password: "wrong-password" });
      expect(res.status).toBe(401);
    }

    const res = await login(app, { username: "alice", password: "wrong-password" });
    expect(res.status).toBe(429);
    const body = await readJson<ApiError>(res);
    expect(body).toMatchObject({ error: { kind: "rate_limited" } });
    expect(body.error.details?.retryAfterMs).toEqual(expect.any(Number));
  });

  it("keeps usernames independent below the per-address bound, then blocks the whole address", async () => {
    const { app } = buildTestApp({ clockCtl });

    for (let i = 0; i < 4; i += 1) {
      await login(app, { username: "alice", password: "wrong-password" });
    }
    // Four failures for alice do not touch bob's own bucket.
    expect((await login(app, { username: "bob", password: "builder" })).status).toBe(200);

    // The fifth failure from this address trips its shared bucket, so even a
    // correct password for another username is refused here (password
    // spraying), while the same login from another address still works.
    await login(app, { username: "alice", password: "wrong-password" });
    expect((await login(app, { username: "bob", password: "builder" })).status).toBe(429);
    expect(
      (
        await login(
          app,
          { username: "bob", password: "builder" },
          { "x-forwarded-for": "198.51.100.4" },
        )
      ).status,
    ).toBe(200);
  });

  it("rejects a cross-site login POST via the CSRF guard", async () => {
    const { app } = buildTestApp({ clockCtl });

    const res = await app.request(ROUTES.auth.login, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ credential: { username: "alice", password: "wonderland" } }),
    });

    expect(res.status).toBe(403);
  });

  it("logs a second identity into the same account it was created under", async () => {
    const { app, repos } = buildTestApp({ clockCtl });

    const first = await login(app, { username: "alice", password: "wonderland" });
    const firstBody = await readJson<MeResponse>(first);
    const second = await login(app, { username: "alice", password: "wonderland" });
    const secondBody = await readJson<MeResponse>(second);

    expect(secondBody.account.id).toBe(firstBody.account.id);
    expect(await repos.identities.listByAccount(firstBody.account.id)).toHaveLength(1);
  });
});

describe("auth routes: GET /auth/me", () => {
  let clockCtl: ReturnType<typeof createClock>;

  beforeEach(() => {
    clockCtl = createClock(Date.now());
  });

  it("returns 200 with a valid session cookie", async () => {
    const { app } = buildTestApp({ clockCtl });
    const loginRes = await login(app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(loginRes);

    const res = await app.request(ROUTES.auth.me, { headers: { cookie } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(MeResponse.safeParse(body).success).toBe(true);
  });

  it("returns 401 without a session cookie", async () => {
    const { app } = buildTestApp({ clockCtl });

    const res = await app.request(ROUTES.auth.me);

    expect(res.status).toBe(401);
  });

  it("returns 401 once the session has expired", async () => {
    const { app } = buildTestApp({ clockCtl, envOverrides: { FDRIVE_SESSION_TTL_DAYS: "1" } });
    const loginRes = await login(app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(loginRes);

    clockCtl.advance(2 * 24 * 60 * 60 * 1000);

    const res = await app.request(ROUTES.auth.me, { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  it("refuses and deletes a session older than FDRIVE_SESSION_MAX_AGE_DAYS even while it keeps sliding", async () => {
    const { app, repos } = buildTestApp({
      clockCtl,
      envOverrides: { FDRIVE_SESSION_TTL_DAYS: "30", FDRIVE_SESSION_MAX_AGE_DAYS: "2" },
    });
    const cookie = extractCookie(await login(app, { username: "alice", password: "wonderland" }));
    const { hashSessionId } = await import("./sessions.js");
    const idHash = hashSessionId(cookie.split("=")[1] ?? "");

    // Daily use keeps the sliding expiry fresh; the absolute cap still ends it.
    clockCtl.advance(24 * 60 * 60 * 1000);
    expect((await app.request(ROUTES.auth.me, { headers: { cookie } })).status).toBe(200);
    clockCtl.advance(24 * 60 * 60 * 1000 + 60 * 1000);
    expect((await app.request(ROUTES.auth.me, { headers: { cookie } })).status).toBe(401);
    expect(await repos.sessions.getByIdHash(idHash, clockCtl.clock())).toBeNull();
  });

  it("slides the session expiry forward on access more than 5 minutes after the last one", async () => {
    const { app, repos } = buildTestApp({
      clockCtl,
      envOverrides: { FDRIVE_SESSION_TTL_DAYS: "1" },
    });
    const loginRes = await login(app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(loginRes);
    const rawSessionId = cookie.split("=")[1];
    if (rawSessionId === undefined) {
      throw new Error("expected a session id in the cookie");
    }
    const { hashSessionId } = await import("./sessions.js");
    const idHash = hashSessionId(rawSessionId);
    const beforeTouch = await repos.sessions.getByIdHash(idHash, clockCtl.clock());
    const originalExpiresAt = beforeTouch?.expiresAt;

    clockCtl.advance(6 * 60 * 1000);
    const res = await app.request(ROUTES.auth.me, { headers: { cookie } });
    expect(res.status).toBe(200);

    const afterTouch = await repos.sessions.getByIdHash(idHash, clockCtl.clock());
    expect(afterTouch?.expiresAt.getTime()).toBeGreaterThan(originalExpiresAt?.getTime() ?? 0);
    expect(afterTouch?.lastSeenAt.getTime()).toBe(clockCtl.clock().getTime());
  });

  it("does not slide the session expiry forward within the 5-minute threshold", async () => {
    const { app, repos } = buildTestApp({ clockCtl });
    const loginRes = await login(app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(loginRes);
    const rawSessionId = cookie.split("=")[1];
    if (rawSessionId === undefined) {
      throw new Error("expected a session id in the cookie");
    }
    const { hashSessionId } = await import("./sessions.js");
    const idHash = hashSessionId(rawSessionId);
    const beforeTouch = await repos.sessions.getByIdHash(idHash, clockCtl.clock());

    clockCtl.advance(60 * 1000);
    await app.request(ROUTES.auth.me, { headers: { cookie } });

    const afterTouch = await repos.sessions.getByIdHash(idHash, clockCtl.clock());
    expect(afterTouch?.lastSeenAt.getTime()).toBe(beforeTouch?.lastSeenAt.getTime());
  });

  it("uses the identity header to act as another identity linked to the same account", async () => {
    const { app, repos } = buildTestApp({ clockCtl });
    const loginRes = await login(app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(loginRes);
    const meBody = await readJson<MeResponse>(loginRes);
    const accountId = meBody.account.id;

    // Link a second identity (a different SFTPGo login) to the same account
    // by inserting it directly, the way a "link another identity" flow
    // would once it exists.
    const provider = await repos.providers.ensure({
      type: "sftpgo",
      baseUrl: "http://sftpgo.internal:8080",
    });
    const secondIdentity = await repos.identities.create({
      accountId,
      providerId: provider.id,
      externalUsername: "alice-work",
    });

    const res = await app.request(ROUTES.auth.me, {
      headers: { cookie, "x-identity-id": secondIdentity.id },
    });

    expect(res.status).toBe(200);
    const body = await readJson<MeResponse>(res);
    expect(body.activeIdentityId).toBe(secondIdentity.id);
  });

  it("returns 403 for an identity header pointing at another account's identity", async () => {
    const { app } = buildTestApp({ clockCtl });
    const aliceLogin = await login(app, { username: "alice", password: "wonderland" });
    const aliceCookie = extractCookie(aliceLogin);
    const bobLogin = await login(app, { username: "bob", password: "builder" });
    const bobBody = await readJson<MeResponse>(bobLogin);
    const bobIdentity = bobBody.identities[0];
    if (bobIdentity === undefined) {
      throw new Error("expected bob to have at least one identity");
    }
    const bobIdentityId = bobIdentity.id;

    const res = await app.request(ROUTES.auth.me, {
      headers: { cookie: aliceCookie, "x-identity-id": bobIdentityId },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ error: { kind: "forbidden" } });
  });

  it("returns 403 for an identity header with an unknown identity id", async () => {
    const { app } = buildTestApp({ clockCtl });
    const loginRes = await login(app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(loginRes);

    const res = await app.request(ROUTES.auth.me, {
      headers: { cookie, "x-identity-id": "00000000-0000-0000-0000-000000000000" },
    });

    expect(res.status).toBe(403);
  });
});

describe("auth routes: POST /auth/logout", () => {
  let clockCtl: ReturnType<typeof createClock>;

  beforeEach(() => {
    clockCtl = createClock(Date.now());
  });

  it("clears the cookie and a subsequent me is 401", async () => {
    const { app } = buildTestApp({ clockCtl });
    const loginRes = await login(app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(loginRes);

    const logoutRes = await app.request(ROUTES.auth.logout, {
      method: "POST",
      headers: { cookie, "x-requested-with": "fdrive" },
    });

    expect(logoutRes.status).toBe(200);
    expect(await logoutRes.json()).toEqual({ ok: true });
    const setCookie = logoutRes.headers.get("set-cookie");
    expect(setCookie).toContain("fdrive_session=;");
    expect(setCookie).toContain("Max-Age=0");

    const meRes = await app.request(ROUTES.auth.me, { headers: { cookie } });
    expect(meRes.status).toBe(401);
  });

  it("requires authentication to call logout at all", async () => {
    const { app } = buildTestApp({ clockCtl });

    const res = await app.request(ROUTES.auth.logout, {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(401);
  });

  it("rejects a cross-site logout POST via the CSRF guard", async () => {
    const { app } = buildTestApp({ clockCtl });
    const loginRes = await login(app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(loginRes);

    const res = await app.request(ROUTES.auth.logout, {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "cross-site" },
    });

    expect(res.status).toBe(403);
  });

  it("is a no-op on the service when there is no session cookie to clear", async () => {
    // Exercises the defensive branch in the route handler directly: a
    // principal resolved without a session cookie present (which
    // `createRequireAuth` never actually produces in normal operation,
    // since resolving one requires the cookie) must not call
    // `service.logout` with `undefined`.
    const logout = vi.fn();
    const app = createApp({
      config: loadConfig(REQUIRED_ENV),
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date(0),
      principalResolver: async () => ({
        accountId: "a",
        identityId: "i",
        username: "alice",
        storage: FAKE_STORAGE,
        isAdmin: false,
      }),
      registerRoutes: (groups) => {
        registerAuthRoutes(groups, {
          service: { logout } as unknown as Parameters<typeof registerAuthRoutes>[1]["service"],
          config: loadConfig(REQUIRED_ENV),
        });
      },
    });

    const res = await app.request(ROUTES.auth.logout, {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(200);
    expect(logout).not.toHaveBeenCalled();
  });
});

describe("withoutApiV1Prefix", () => {
  it("strips the /api/v1 prefix", async () => {
    const { withoutApiV1Prefix } = await import("./routes.js");
    expect(withoutApiV1Prefix("/api/v1/auth/login")).toBe("/auth/login");
  });

  it("returns the path unchanged when it has no /api/v1 prefix", async () => {
    const { withoutApiV1Prefix } = await import("./routes.js");
    expect(withoutApiV1Prefix("/auth/login")).toBe("/auth/login");
  });
});

describe("auth routes: request ip extraction", () => {
  let clockCtl: ReturnType<typeof createClock>;

  beforeEach(() => {
    clockCtl = createClock(Date.now());
  });

  it("uses the first hop of a comma-separated x-forwarded-for", async () => {
    const { app } = buildTestApp({ clockCtl });

    const res = await login(
      app,
      { username: "alice", password: "wonderland" },
      { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    );

    expect(res.status).toBe(200);
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    const { app } = buildTestApp({ clockCtl });

    const res = await login(
      app,
      { username: "alice", password: "wonderland" },
      { "x-real-ip": "203.0.113.8" },
    );

    expect(res.status).toBe(200);
  });

  it("passes an otp through to the SFTPGo login call", async () => {
    const { app } = buildTestApp({ clockCtl });

    const res = await login(app, { username: "alice", password: "wonderland", otp: "123456" });

    // The fake SFTPGo server does not require TOTP for this seeded user, so
    // an otp is simply accepted alongside the correct password.
    expect(res.status).toBe(200);
  });
});

describe("auth routes: login upstream error mapping", () => {
  let clockCtl: ReturnType<typeof createClock>;

  beforeEach(() => {
    clockCtl = createClock(Date.now());
  });

  it("maps a forbidden SFTPGo response to 403 with SFTPGo's detail", async () => {
    const { app } = buildTestApp({
      clockCtl,
      wrapFetch: (fetch) => async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/v2/user/token")) {
          return new Response(JSON.stringify({ error: "account disabled" }), { status: 403 });
        }
        return fetch(input, init);
      },
    });

    const res = await login(app, { username: "alice", password: "wonderland" });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ error: { kind: "forbidden", message: "account disabled" } });
  });

  it("maps a network failure to upstream_unavailable", async () => {
    const { app } = buildTestApp({
      clockCtl,
      wrapFetch: (fetch) => async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/v2/user/token")) {
          throw new Error("connection refused");
        }
        return fetch(input, init);
      },
    });

    const res = await login(app, { username: "alice", password: "wonderland" });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: { kind: "upstream_unavailable" } });
  });
});

describe("auth service: direct edge cases", () => {
  let clockCtl: ReturnType<typeof createClock>;

  beforeEach(() => {
    clockCtl = createClock(Date.now());
  });

  it("me() throws internal when the account no longer exists", async () => {
    const { authModule } = buildTestApp({ clockCtl });

    await expect(
      authModule.service.me("00000000-0000-0000-0000-000000000000", "irrelevant"),
    ).rejects.toMatchObject({ kind: "internal" });
  });

  it("resolvePrincipal returns null (unauthorized) when the session has no active identity", async () => {
    const { app, repos } = buildTestApp({ clockCtl });
    const account = await repos.accounts.create({ displayName: "no-identity" });
    const { generateSessionId, hashSessionId } = await import("./sessions.js");
    const rawSessionId = generateSessionId();
    await repos.sessions.create({
      idHash: hashSessionId(rawSessionId),
      accountId: account.id,
      activeIdentityId: null,
      expiresAt: new Date(clockCtl.clock().getTime() + 60_000),
      userAgent: null,
      ip: null,
    });

    const res = await app.request(ROUTES.auth.me, {
      headers: { cookie: `fdrive_session=${rawSessionId}` },
    });

    expect(res.status).toBe(401);
  });

  it("resolvePrincipal returns null (unauthorized) when the active identity no longer exists", async () => {
    const { app, repos } = buildTestApp({ clockCtl });
    const account = await repos.accounts.create({ displayName: "dangling-identity" });
    const { generateSessionId, hashSessionId } = await import("./sessions.js");
    const rawSessionId = generateSessionId();
    await repos.sessions.create({
      idHash: hashSessionId(rawSessionId),
      accountId: account.id,
      activeIdentityId: "00000000-0000-0000-0000-000000000000",
      expiresAt: new Date(clockCtl.clock().getTime() + 60_000),
      userAgent: null,
      ip: null,
    });

    const res = await app.request(ROUTES.auth.me, {
      headers: { cookie: `fdrive_session=${rawSessionId}` },
    });

    expect(res.status).toBe(401);
  });
});

describe("auth service: principal.verifyAuthority", () => {
  async function principalFor(h: ReturnType<typeof buildTestApp>, cookie: string) {
    const { Context } = await import("hono");
    const ctx = new Context(new Request("http://test/api/v1/fs/compress", { headers: { cookie } }));
    const principal = await h.authModule.service.resolvePrincipal(ctx);
    if (principal === null || principal.verifyAuthority === undefined) {
      throw new Error("expected a session principal with verifyAuthority");
    }
    return { ...principal, verifyAuthority: principal.verifyAuthority };
  }

  it("holds while the session lives and turns false once it is logged out", async () => {
    const h = buildTestApp({ clockCtl: createClock(Date.now()) });
    const cookie = extractCookie(await login(h.app, { username: "alice", password: "wonderland" }));
    const principal = await principalFor(h, cookie);

    expect(await principal.verifyAuthority()).toBe(true);

    const logoutRes = await h.app.request(ROUTES.auth.logout, {
      method: "POST",
      headers: { cookie, "x-requested-with": "fdrive" },
    });
    expect(logoutRes.status).toBe(200);

    expect(await principal.verifyAuthority()).toBe(false);
  });

  it("turns false once the session passes its maximum age, even while it keeps sliding", async () => {
    const clockCtl = createClock(Date.now());
    const h = buildTestApp({
      clockCtl,
      envOverrides: { FDRIVE_SESSION_TTL_DAYS: "30", FDRIVE_SESSION_MAX_AGE_DAYS: "2" },
    });
    const cookie = extractCookie(await login(h.app, { username: "alice", password: "wonderland" }));
    const principal = await principalFor(h, cookie);

    clockCtl.advance(24 * 60 * 60 * 1000);
    expect(await principal.verifyAuthority()).toBe(true);

    // The session's createdAt comes from the wall clock in the memory repo,
    // so leave a real-time margin rather than a single millisecond.
    clockCtl.advance(24 * 60 * 60 * 1000 + 1000);
    expect(await principal.verifyAuthority()).toBe(false);
  });
});

describe("native safe-request identity selection", () => {
  it("selects an owned query identity for GET/HEAD without switching session", async () => {
    const h = buildTestApp({ clockCtl: createClock(Date.now()) });
    const response = await login(h.app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(response);
    const me = await readJson<MeResponse>(response);
    const provider = await h.repos.providers.ensure({
      type: "sftpgo",
      baseUrl: "http://sftpgo.internal:8080",
    });
    const other = await h.repos.identities.create({
      accountId: me.account.id,
      providerId: provider.id,
      externalUsername: "alice-other",
    });
    expect(
      (
        await h.app.request(`${ROUTES.auth.me}?identity=${other.id}&identity=${other.id}`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(403);
    for (const method of ["GET", "HEAD"]) {
      const result = await h.app.request(`${ROUTES.auth.me}?identity=${other.id}`, {
        method,
        headers: { cookie },
      });
      expect(result.status).toBe(200);
      if (method === "GET")
        expect((await readJson<MeResponse>(result)).activeIdentityId).toBe(other.id);
    }
    expect(
      (await readJson<MeResponse>(await h.app.request(ROUTES.auth.me, { headers: { cookie } })))
        .activeIdentityId,
    ).toBe(me.activeIdentityId);
    expect(
      (
        await h.app.request(`${ROUTES.auth.me}?identity=${other.id}`, {
          headers: { cookie, "x-identity-id": other.id },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.app.request(`${ROUTES.auth.me}?identity=${other.id}`, {
          headers: { cookie, "x-identity-id": me.activeIdentityId },
        })
      ).status,
    ).toBe(403);
    for (const id of ["", "missing"]) {
      expect(
        (await h.app.request(`${ROUTES.auth.me}?identity=${id}`, { headers: { cookie } })).status,
      ).toBe(403);
    }
    const foreignLogin = await login(h.app, { username: "bob", password: "builder" });
    const foreign = await readJson<MeResponse>(foreignLogin);
    expect(
      (
        await h.app.request(`${ROUTES.auth.me}?identity=${foreign.activeIdentityId}`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(403);
  });
});
