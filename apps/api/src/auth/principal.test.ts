import type { StorageProvider } from "@fdrive/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ApiHttpError } from "../errors";
import {
  createCsrfGuard,
  createRequireAuth,
  type Principal,
  type PrincipalResolver,
  type PrincipalVariables,
} from "./principal";

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

const PRINCIPAL: Principal = {
  accountId: "account-1",
  identityId: "identity-1",
  username: "alice",
  storage: FAKE_STORAGE,
};

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
