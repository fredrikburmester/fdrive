import { type ApiError, MeResponse, ROUTES } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Repos } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { filesFolderFixture, seedLocalUsers } from "../local/test-fixtures/index.ts";
import {
  createAuthModule,
  createLoginLimiter,
  createPasswordCheck,
  type Installation,
} from "./index";
import { createPrincipalFactory } from "./principal";
import { registerAuthRoutes } from "./routes";

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
  deleteEmptyDir: notImplemented,
  setModifiedAt: notImplemented,
  zip: notImplemented,
};

const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_STORAGE_ROOT: "/srv/files",
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

/** The setup gate open: these tests exercise auth, not setup. */
const READY = async () => false;

const USERS = [
  { username: "alice", password: "wonderland" },
  { username: "bob", password: "builder" },
];

/** The auth routes over the deployment's local folder, pinned, with alice and bob. */
async function buildTestApp(opts: {
  clockCtl: ReturnType<typeof createClock>;
  envOverrides?: Record<string, string>;
  installation?: () => Promise<Installation>;
}) {
  const repos: Repos = createMemoryRepos();
  const config = loadConfig({ ...REQUIRED_ENV, ...opts.envOverrides });
  const local = filesFolderFixture(repos);
  await seedLocalUsers(repos, USERS);
  const authModule = createAuthModule({
    repos,
    clock: opts.clockCtl.clock,
    config,
    checkPassword: createPasswordCheck({
      limiter: createLoginLimiter({ clock: opts.clockCtl.clock }),
      users: local.users,
    }),
    principalFor: createPrincipalFactory({
      folder: { storage: () => FAKE_STORAGE },
      clock: opts.clockCtl.clock,
    }),
    installation:
      opts.installation ??
      (async () => ({ storageName: "Local folder", trash: false, index: false })),
  });
  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date(0),
    clock: opts.clockCtl.clock,
    principalResolver: authModule.principalResolver,
    setupRequired: READY,
    registerRoutes: authModule.registerRoutes,
  });

  return { app, repos, users: local.users, config, authModule };
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
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
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
    body: JSON.stringify(body),
  });
}

describe("auth routes: POST /auth/login", () => {
  let clockCtl: ReturnType<typeof createClock>;

  beforeEach(() => {
    clockCtl = createClock(Date.now());
  });

  it("succeeds with correct credentials, returns MeResponse, and sets a non-Secure cookie over plain http", async () => {
    const { app } = await buildTestApp({ clockCtl });

    const res = await login(app, { username: "alice", password: "wonderland" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(MeResponse.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      account: { displayName: "alice" },
      identity: { username: "alice" },
      storageName: "Local folder",
    });

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("fdrive_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
  });

  it("sets a Secure cookie when the request arrived over a forwarded https connection", async () => {
    const { app } = await buildTestApp({ clockCtl });

    const res = await login(
      app,
      { username: "alice", password: "wonderland" },
      { "x-forwarded-proto": "https" },
    );

    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("returns 401 unauthorized for a wrong password", async () => {
    const { app } = await buildTestApp({ clockCtl });

    const res = await login(app, { username: "alice", password: "wrong-password" });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: { kind: "unauthorized" } });
  });

  it("returns 400 bad_request with zod issues for a malformed body", async () => {
    const { app } = await buildTestApp({ clockCtl });

    const res = await login(app, { username: "" });

    expect(res.status).toBe(400);
    const body = await readJson<ApiError>(res);
    expect(body.error.kind).toBe("bad_request");
    expect(body.error.details?.issues).toEqual(expect.any(Array));
  });

  it("returns 400 bad_request for a body that is not valid JSON", async () => {
    const { app } = await buildTestApp({ clockCtl });

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
    const { app } = await buildTestApp({ clockCtl });

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
    const { app } = await buildTestApp({ clockCtl });

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
    const { app } = await buildTestApp({ clockCtl });

    const res = await app.request(ROUTES.auth.login, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ username: "alice", password: "wonderland" }),
    });

    expect(res.status).toBe(403);
  });

  it("signs a login in again to the account it was created under", async () => {
    const { app, repos } = await buildTestApp({ clockCtl });

    const first = await login(app, { username: "alice", password: "wonderland" });
    const firstBody = await readJson<MeResponse>(first);
    const second = await login(app, { username: "alice", password: "wonderland" });
    const secondBody = await readJson<MeResponse>(second);

    expect(secondBody.account.id).toBe(firstBody.account.id);
    expect(secondBody.identity.id).toBe(firstBody.identity.id);
    expect(await repos.identities.listAll()).toHaveLength(USERS.length);
  });
});

describe("auth routes: GET /auth/me", () => {
  let clockCtl: ReturnType<typeof createClock>;

  beforeEach(() => {
    clockCtl = createClock(Date.now());
  });

  it("returns 200 with a valid session cookie", async () => {
    const { app } = await buildTestApp({ clockCtl });
    const loginRes = await login(app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(loginRes);

    const res = await app.request(ROUTES.auth.me, { headers: { cookie } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(MeResponse.safeParse(body).success).toBe(true);
  });

  it("returns 401 without a session cookie", async () => {
    const { app } = await buildTestApp({ clockCtl });

    const res = await app.request(ROUTES.auth.me);

    expect(res.status).toBe(401);
  });

  it("returns 401 once the session has expired", async () => {
    const { app } = await buildTestApp({
      clockCtl,
      envOverrides: { FDRIVE_SESSION_TTL_DAYS: "1" },
    });
    const loginRes = await login(app, { username: "alice", password: "wonderland" });
    const cookie = extractCookie(loginRes);

    clockCtl.advance(2 * 24 * 60 * 60 * 1000);

    const res = await app.request(ROUTES.auth.me, { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  it("refuses and deletes a session older than FDRIVE_SESSION_MAX_AGE_DAYS even while it keeps sliding", async () => {
    const { app, repos } = await buildTestApp({
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
    const { app, repos } = await buildTestApp({
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
    const { app, repos } = await buildTestApp({ clockCtl });
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

  it("ignores an identity header or query: the session names its login", async () => {
    const { app } = await buildTestApp({ clockCtl });
    const aliceLogin = await login(app, { username: "alice", password: "wonderland" });
    const aliceCookie = extractCookie(aliceLogin);
    const alice = await readJson<MeResponse>(aliceLogin);
    const bob = await readJson<MeResponse>(
      await login(app, { username: "bob", password: "builder" }),
    );

    const res = await app.request(`${ROUTES.auth.me}?identity=${bob.identity.id}`, {
      headers: { cookie: aliceCookie, "x-identity-id": bob.identity.id },
    });

    expect(res.status).toBe(200);
    expect((await readJson<MeResponse>(res)).identity.id).toBe(alice.identity.id);
  });
});

describe("auth routes: POST /auth/logout", () => {
  let clockCtl: ReturnType<typeof createClock>;

  beforeEach(() => {
    clockCtl = createClock(Date.now());
  });

  it("clears the cookie and a subsequent me is 401", async () => {
    const { app } = await buildTestApp({ clockCtl });
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

  it("clears with the same Secure attribute login set behind the trusted proxy", async () => {
    // The forwarded chain carries a client-prepended "http" in front of the
    // single trusted proxy's "https": both the cookie that is set and the
    // cookie that clears it must still be Secure, or logout leaves the
    // browser holding the session cookie it was meant to drop.
    const { app } = await buildTestApp({ clockCtl });
    const forwarded = { "x-forwarded-proto": "http, https" };
    const loginRes = await login(app, { username: "alice", password: "wonderland" }, forwarded);
    expect(loginRes.headers.get("set-cookie")).toContain("Secure");
    const cookie = extractCookie(loginRes);

    const logoutRes = await app.request(ROUTES.auth.logout, {
      method: "POST",
      headers: { cookie, "x-requested-with": "fdrive", ...forwarded },
    });

    expect(logoutRes.status).toBe(200);
    const setCookie = logoutRes.headers.get("set-cookie");
    expect(setCookie).toContain("fdrive_session=;");
    expect(setCookie).toContain("Secure");
  });

  it("requires authentication to call logout at all", async () => {
    const { app } = await buildTestApp({ clockCtl });

    const res = await app.request(ROUTES.auth.logout, {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(401);
  });

  it("rejects a cross-site logout POST via the CSRF guard", async () => {
    const { app } = await buildTestApp({ clockCtl });
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
      setupRequired: READY,
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
    const { app } = await buildTestApp({ clockCtl });

    const res = await login(
      app,
      { username: "alice", password: "wonderland" },
      { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    );

    expect(res.status).toBe(200);
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    const { app } = await buildTestApp({ clockCtl });

    const res = await login(
      app,
      { username: "alice", password: "wonderland" },
      { "x-real-ip": "203.0.113.8" },
    );

    expect(res.status).toBe(200);
  });
});

describe("auth routes: login error mapping", () => {
  let clockCtl: ReturnType<typeof createClock>;

  beforeEach(() => {
    clockCtl = createClock(Date.now());
  });

  it("refuses a disabled user with 403 only once the password is right", async () => {
    const { app, repos } = await buildTestApp({ clockCtl });
    await repos.localUsers.update("alice", { disabled: true });

    const wrong = await login(app, { username: "alice", password: "nope" });
    expect(wrong.status).toBe(401);

    const res = await login(app, { username: "alice", password: "wonderland" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { kind: "forbidden", message: "this user may not sign in" },
    });
  });

  it("answers users that cannot be read with an internal error that leaks nothing", async () => {
    const { app, users } = await buildTestApp({ clockCtl });
    vi.spyOn(users, "verify").mockRejectedValueOnce(new Error("connection refused"));

    const res = await login(app, { username: "alice", password: "wonderland" });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: { kind: "internal" } });
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });
});

describe("auth service: direct edge cases", () => {
  let clockCtl: ReturnType<typeof createClock>;

  beforeEach(() => {
    clockCtl = createClock(Date.now());
  });

  it("me() asks a login that no longer exists to sign in again", async () => {
    const { authModule } = await buildTestApp({ clockCtl });

    await expect(
      authModule.service.me("00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("resolvePrincipal returns null (unauthorized) when the session's login no longer exists", async () => {
    const { app, repos } = await buildTestApp({ clockCtl });
    const account = await repos.accounts.create({ displayName: "dangling-identity" });
    const { generateSessionId, hashSessionId } = await import("./sessions.js");
    const rawSessionId = generateSessionId();
    await repos.sessions.create({
      idHash: hashSessionId(rawSessionId),
      accountId: account.id,
      identityId: "00000000-0000-0000-0000-000000000000",
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
  async function principalFor(h: Awaited<ReturnType<typeof buildTestApp>>, cookie: string) {
    const { Context } = await import("hono");
    const ctx = new Context(new Request("http://test/api/v1/fs/compress", { headers: { cookie } }));
    const principal = await h.authModule.service.resolvePrincipal(ctx);
    if (principal === null || principal.verifyAuthority === undefined) {
      throw new Error("expected a session principal with verifyAuthority");
    }
    return { ...principal, verifyAuthority: principal.verifyAuthority };
  }

  it("holds while the session lives and turns false once it is logged out", async () => {
    const h = await buildTestApp({ clockCtl: createClock(Date.now()) });
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
    const h = await buildTestApp({
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

describe("auth: administrators and installation flags", () => {
  it("names administrators from their account alone", async () => {
    const { app, repos } = await buildTestApp({ clockCtl: createClock(Date.now()) });
    await repos.logins.updateUser("alice", { isAdmin: true, at: new Date() });

    const alice = await readJson<MeResponse>(
      await login(app, { username: "alice", password: "wonderland" }),
    );
    const bob = await readJson<MeResponse>(
      await login(app, { username: "bob", password: "builder" }),
    );

    expect(alice.isAdmin).toBe(true);
    expect(bob.isAdmin).toBe(false);
  });

  it("reports the storage name, Trash and indexing, read on every request", async () => {
    let flags = { storageName: "Local folder", trash: false, index: true };
    const { app } = await buildTestApp({
      clockCtl: createClock(Date.now()),
      installation: async () => flags,
    });
    const response = await login(app, { username: "bob", password: "builder" });
    const signedIn = await readJson<MeResponse>(response);
    expect(signedIn).toMatchObject(flags);

    flags = { storageName: "Family files", trash: true, index: false };
    const me = await readJson<MeResponse>(
      await app.request(ROUTES.auth.me, { headers: { cookie: extractCookie(response) } }),
    );
    expect(me).toMatchObject(flags);
  });
});
