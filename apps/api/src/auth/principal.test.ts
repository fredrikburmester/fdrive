import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/testkit";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../errors";
import {
  createCsrfGuard,
  createPrincipalFactory,
  createRequireAdmin,
  createRequireAuth,
  type Principal,
  type PrincipalResolver,
  type PrincipalVariables,
} from "./principal";

const FAKE_STORAGE: StorageProvider = createMemoryStorage();

const PRINCIPAL: Principal = {
  accountId: "account-1",
  identityId: "identity-1",
  username: "alice",
  storage: FAKE_STORAGE,
  isAdmin: false,
};

const ADMIN_PRINCIPAL: Principal = { ...PRINCIPAL, isAdmin: true };

function buildAuthedApp(resolve: PrincipalResolver) {
  const app = new Hono<{ Variables: PrincipalVariables }>();
  app.use("*", createRequireAuth(resolve));
  app.get("/whoami", (c) => c.json({ username: c.get("principal").username }));
  app.onError((err, c) => {
    if (err instanceof ApiHttpError) {
      return c.json(
        { kind: err.kind, message: err.message },
        err.kind === "unauthorized" ? 401 : 403,
      );
    }
    throw err;
  });
  return app;
}

describe("createRequireAuth", () => {
  it("sets the principal and calls through when resolve returns one", async () => {
    const app = buildAuthedApp(async () => PRINCIPAL);

    const res = await app.request("/whoami");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "alice" });
  });

  it("throws an unauthorized ApiHttpError when resolve returns null", async () => {
    const app = buildAuthedApp(async () => null);

    const res = await app.request("/whoami");

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ kind: "unauthorized" });
  });
});

function buildAdminGuardedApp(resolve: PrincipalResolver) {
  const app = new Hono<{ Variables: PrincipalVariables }>();
  app.use("*", createRequireAuth(resolve));
  app.use("*", createRequireAdmin());
  app.get("/admin-only", (c) => c.json({ username: c.get("principal").username }));
  app.onError((err, c) => {
    if (err instanceof ApiHttpError) {
      return c.json(
        { kind: err.kind, message: err.message },
        err.kind === "unauthorized" ? 401 : 403,
      );
    }
    throw err;
  });
  return app;
}

describe("createRequireAdmin", () => {
  it("calls through for an admin principal", async () => {
    const app = buildAdminGuardedApp(async () => ADMIN_PRINCIPAL);

    const res = await app.request("/admin-only");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "alice" });
  });

  it("throws a forbidden ApiHttpError for a non-admin principal", async () => {
    const app = buildAdminGuardedApp(async () => PRINCIPAL);

    const res = await app.request("/admin-only");

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "forbidden" });
  });
});

function buildCsrfApp() {
  const app = new Hono();
  app.use("*", createCsrfGuard());
  app.all("/action", (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof ApiHttpError) {
      return c.json({ kind: err.kind, message: err.message }, 403);
    }
    throw err;
  });
  return app;
}

describe("createCsrfGuard", () => {
  it("allows a GET request through with no headers", async () => {
    const app = buildCsrfApp();

    const res = await app.request("/action", { method: "GET" });

    expect(res.status).toBe(200);
  });

  it("allows a POST with sec-fetch-site same-origin and the requested-with header", async () => {
    const app = buildCsrfApp();

    const res = await app.request("/action", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(200);
  });

  it("allows a POST with sec-fetch-site none and the requested-with header", async () => {
    const app = buildCsrfApp();

    const res = await app.request("/action", {
      method: "POST",
      headers: { "sec-fetch-site": "none", "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(200);
  });

  it("allows a POST with no sec-fetch-site header at all, given the requested-with header", async () => {
    const app = buildCsrfApp();

    const res = await app.request("/action", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(200);
  });

  it("rejects a POST with sec-fetch-site cross-site", async () => {
    const app = buildCsrfApp();

    const res = await app.request("/action", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "forbidden" });
  });

  it("rejects a POST missing the x-requested-with header", async () => {
    const app = buildCsrfApp();

    const res = await app.request("/action", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });

    expect(res.status).toBe(403);
  });

  it("rejects a POST with the wrong x-requested-with value", async () => {
    const app = buildCsrfApp();

    const res = await app.request("/action", {
      method: "POST",
      headers: { "x-requested-with": "xmlhttprequest" },
    });

    expect(res.status).toBe(403);
  });

  it.each(["PUT", "PATCH", "DELETE"])("guards %s the same way it guards POST", async (method) => {
    const app = buildCsrfApp();

    const res = await app.request("/action", { method });

    expect(res.status).toBe(403);
  });

  it("allows a HEAD request through with no headers", async () => {
    const app = buildCsrfApp();

    const res = await app.request("/action", { method: "HEAD" });

    expect(res.status).toBe(200);
  });
});

describe("createPrincipalFactory", () => {
  const login = {
    identityId: "identity-1",
    accountId: "account-1",
    username: "alice",
    displayName: "Alice",
    isAdmin: true,
    active: true,
  };

  it("builds no storage for a request that touches no files, and one for one that does", async () => {
    const storage = vi.fn(() => createMemoryStorage({ "/a.txt": "a" }));
    const principalFor = createPrincipalFactory({ folder: { storage } });

    const idle = await principalFor(login);
    expect(idle).toMatchObject({
      accountId: "account-1",
      identityId: "identity-1",
      username: "alice",
      isAdmin: true,
    });
    expect(storage).not.toHaveBeenCalled();

    const busy = await principalFor(login, { tokenAccess: { mode: "read", paths: ["/"] } });
    expect(busy.tokenAccess).toEqual({ mode: "read", paths: ["/"] });
    expect(busy.storage).toBe(busy.storage);
    expect(storage).toHaveBeenCalledExactlyOnceWith("alice");
    expect(busy.storage.trash).toBeDefined();
  });

  it("refuses a login whose name cannot be a home folder when its storage is first used", async () => {
    const principalFor = createPrincipalFactory({
      folder: {
        storage: () => {
          throw new StorageError("forbidden", "this login has no valid home folder");
        },
      },
    });
    const principal = await principalFor({ ...login, username: ".." });
    expect(() => principal.storage).toThrow(ApiHttpError);
  });
});
