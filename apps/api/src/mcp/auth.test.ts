import type { StorageProvider } from "@fdrive/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Principal } from "../auth/principal.js";
import { parseBearerHeader, resolveMcpPrincipal } from "./auth.js";

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

const FAKE_PRINCIPAL: Principal = {
  accountId: "account-1",
  identityId: "identity-1",
  username: "alice",
  storage: FAKE_STORAGE,
  isAdmin: false,
};

describe("parseBearerHeader", () => {
  it("extracts the token from a Bearer header", () => {
    expect(parseBearerHeader("Bearer fdr_abc123")).toBe("fdr_abc123");
  });

  it("is case-insensitive on the Bearer scheme", () => {
    expect(parseBearerHeader("bearer fdr_abc123")).toBe("fdr_abc123");
  });

  it("trims surrounding whitespace from the token", () => {
    expect(parseBearerHeader("Bearer   fdr_abc123  ")).toBe("fdr_abc123");
  });

  it("returns null for a missing header", () => {
    expect(parseBearerHeader(undefined)).toBeNull();
  });

  it("returns null for a header without the Bearer scheme", () => {
    expect(parseBearerHeader("Basic abc123")).toBeNull();
  });

  it("returns null for a bare Bearer with no token", () => {
    expect(parseBearerHeader("Bearer")).toBeNull();
  });
});

describe("resolveMcpPrincipal", () => {
  it("resolves via the path token when present, ignoring any header", async () => {
    const app = new Hono();
    let received: unknown;
    app.get("/mcp/t/:token", async (c) => {
      received = await resolveMcpPrincipal(c, {
        resolveToken: async (token) => {
          expect(token).toBe("path-token");
          return FAKE_PRINCIPAL;
        },
      });
      return c.json({ ok: true });
    });

    await app.request("/mcp/t/path-token", { headers: { authorization: "Bearer header-token" } });

    expect(received).toBe(FAKE_PRINCIPAL);
  });

  it("resolves via the Authorization header when there is no path token", async () => {
    const app = new Hono();
    let received: unknown;
    app.get("/mcp", async (c) => {
      received = await resolveMcpPrincipal(c, {
        resolveToken: async (token) => {
          expect(token).toBe("header-token");
          return FAKE_PRINCIPAL;
        },
      });
      return c.json({ ok: true });
    });

    await app.request("/mcp", { headers: { authorization: "Bearer header-token" } });

    expect(received).toBe(FAKE_PRINCIPAL);
  });

  it("returns null when neither a path token nor a header is present", async () => {
    const app = new Hono();
    let received: unknown = "not set";
    app.get("/mcp", async (c) => {
      received = await resolveMcpPrincipal(c, { resolveToken: async () => FAKE_PRINCIPAL });
      return c.json({ ok: true });
    });

    await app.request("/mcp");

    expect(received).toBeNull();
  });

  it("returns null when the resolved token is invalid", async () => {
    const app = new Hono();
    let received: unknown = "not set";
    app.get("/mcp", async (c) => {
      received = await resolveMcpPrincipal(c, { resolveToken: async () => null });
      return c.json({ ok: true });
    });

    await app.request("/mcp", { headers: { authorization: "Bearer bad-token" } });

    expect(received).toBeNull();
  });
});
