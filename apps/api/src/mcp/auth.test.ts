import type { StorageProvider } from "@fdrive/core";
import { type Context, Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createLoginLimiter, DEFAULT_MAX_FAILURES } from "../auth/login-limiter.js";
import type { Principal } from "../auth/principal.js";
import { generateApiToken } from "../tokens/token-format.js";
import { authenticateMcpRequest, type McpAuthResult, parseBearerHeader } from "./auth.js";

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

const FAKE_PRINCIPAL: Principal = {
  accountId: "account-1",
  identityId: "identity-1",
  username: "alice",
  storage: FAKE_STORAGE,
  isAdmin: false,
};

/** The one token the default harness resolver recognizes. */
const KNOWN_TOKEN = generateApiToken();

/** Reads the address a test wants a request attributed to, defaulting to a single caller. */
function testClientIp(c: Context): string {
  return c.req.header("x-test-client") ?? "198.51.100.7";
}

interface HarnessOptions {
  readonly now?: () => Date;
  readonly capacity?: number;
}

interface Harness {
  /** Issues one request through the real route shapes and returns the authentication outcome. */
  request(path: string, init?: RequestInit): Promise<McpAuthResult>;
  /** Every value handed to `resolveToken`, in order: the lookups that would hit the database. */
  readonly lookups: string[];
}

/**
 * Mounts `authenticateMcpRequest` behind both MCP route shapes so the path
 * token arrives exactly as Hono delivers it, with one limiter shared across
 * the harness's requests.
 */
function harness(options: HarnessOptions = {}): Harness {
  const lookups: string[] = [];
  const limiter = createLoginLimiter({
    clock: options.now ?? (() => new Date()),
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
  });

  const app = new Hono();
  let last: McpAuthResult = { kind: "unauthorized" };
  const handler = async (c: Context) => {
    last = await authenticateMcpRequest(c, {
      resolveToken: async (token) => {
        lookups.push(token);
        return token === KNOWN_TOKEN ? FAKE_PRINCIPAL : null;
      },
      limiter,
      clientIp: testClientIp,
    });
    return c.json({ ok: true });
  };
  app.get("/mcp", handler);
  app.get("/mcp/t/:token", handler);

  return {
    async request(path, init) {
      await app.request(path, init);
      return last;
    },
    lookups,
  };
}

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

describe("authenticateMcpRequest", () => {
  it("resolves via the path token when present, ignoring any header", async () => {
    const app = harness();

    const result = await app.request(`/mcp/t/${KNOWN_TOKEN}`, {
      headers: { authorization: `Bearer ${generateApiToken()}` },
    });

    expect(result).toEqual({ kind: "ok", principal: FAKE_PRINCIPAL });
    expect(app.lookups).toEqual([KNOWN_TOKEN]);
  });

  it("resolves via the Authorization header when there is no path token", async () => {
    const app = harness();

    const result = await app.request("/mcp", {
      headers: { authorization: `Bearer ${KNOWN_TOKEN}` },
    });

    expect(result).toEqual({ kind: "ok", principal: FAKE_PRINCIPAL });
    expect(app.lookups).toEqual([KNOWN_TOKEN]);
  });

  it("rejects a request with no credentials at all without a lookup", async () => {
    const app = harness();

    expect(await app.request("/mcp")).toEqual({ kind: "unauthorized" });
    expect(app.lookups).toEqual([]);
  });

  it("rejects a header token that is not token-shaped without a lookup", async () => {
    const app = harness();

    const result = await app.request("/mcp", { headers: { authorization: "Bearer header" } });

    expect(result).toEqual({ kind: "unauthorized" });
    expect(app.lookups).toEqual([]);
  });

  it("rejects a path token that is not token-shaped without a lookup", async () => {
    const app = harness();

    for (const segment of ["path-token", "fdr_x", `fdr_${"a".repeat(42)}`, "fdr_%20"]) {
      expect(await app.request(`/mcp/t/${segment}`)).toEqual({ kind: "unauthorized" });
    }
    expect(app.lookups).toEqual([]);
  });

  it("never spends the failure budget on a misshapen credential", async () => {
    const app = harness();

    for (let i = 0; i < DEFAULT_MAX_FAILURES * 10; i++) {
      await app.request("/mcp/t/nonsense");
    }

    expect(await app.request(`/mcp/t/${KNOWN_TOKEN}`)).toEqual({
      kind: "ok",
      principal: FAKE_PRINCIPAL,
    });
  });

  it("rejects a token-shaped value the resolver does not recognize", async () => {
    const app = harness();
    const unknown = generateApiToken();

    expect(await app.request(`/mcp/t/${unknown}`)).toEqual({ kind: "unauthorized" });
    expect(app.lookups).toEqual([unknown]);
  });

  it("stops looking tokens up once one address has burned its failure budget", async () => {
    const app = harness();

    for (let i = 0; i < DEFAULT_MAX_FAILURES; i++) {
      expect(await app.request(`/mcp/t/${generateApiToken()}`)).toEqual({ kind: "unauthorized" });
    }
    expect(app.lookups).toHaveLength(DEFAULT_MAX_FAILURES);

    expect((await app.request(`/mcp/t/${generateApiToken()}`)).kind).toBe("rate_limited");
    expect(app.lookups).toHaveLength(DEFAULT_MAX_FAILURES);
  });

  it("reports how long a blocked address must wait", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const app = harness({ now: () => now });

    for (let i = 0; i < DEFAULT_MAX_FAILURES; i++) {
      await app.request(`/mcp/t/${generateApiToken()}`);
    }
    now = new Date(now.getTime() + 10_000);

    expect(await app.request(`/mcp/t/${generateApiToken()}`)).toEqual({
      kind: "rate_limited",
      retryAfterMs: 50_000,
    });
  });

  it("reports no wait when the limiter is at capacity rather than blocking an address", async () => {
    const app = harness({ capacity: 0 });

    expect(await app.request(`/mcp/t/${KNOWN_TOKEN}`)).toEqual({
      kind: "rate_limited",
      retryAfterMs: 0,
    });
    expect(app.lookups).toEqual([]);
  });

  it("lets a blocked address back in once the block expires", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const app = harness({ now: () => now });

    for (let i = 0; i < DEFAULT_MAX_FAILURES; i++) {
      await app.request(`/mcp/t/${generateApiToken()}`);
    }
    expect((await app.request(`/mcp/t/${KNOWN_TOKEN}`)).kind).toBe("rate_limited");

    now = new Date(now.getTime() + 60_001);
    expect(await app.request(`/mcp/t/${KNOWN_TOKEN}`)).toEqual({
      kind: "ok",
      principal: FAKE_PRINCIPAL,
    });
  });

  it("never throttles a client that keeps presenting a live token", async () => {
    const app = harness();

    for (let i = 0; i < DEFAULT_MAX_FAILURES * 20; i++) {
      expect((await app.request(`/mcp/t/${KNOWN_TOKEN}`)).kind).toBe("ok");
    }
  });

  it("clears an address's failures once it authenticates", async () => {
    const app = harness();

    for (let i = 0; i < DEFAULT_MAX_FAILURES - 1; i++) {
      await app.request(`/mcp/t/${generateApiToken()}`);
    }
    expect((await app.request(`/mcp/t/${KNOWN_TOKEN}`)).kind).toBe("ok");

    for (let i = 0; i < DEFAULT_MAX_FAILURES - 1; i++) {
      expect((await app.request(`/mcp/t/${generateApiToken()}`)).kind).toBe("unauthorized");
    }
  });

  it("blocks only the address that failed", async () => {
    const app = harness();
    const other = { headers: { "x-test-client": "203.0.113.9" } };

    for (let i = 0; i < DEFAULT_MAX_FAILURES; i++) {
      await app.request(`/mcp/t/${generateApiToken()}`);
    }
    expect((await app.request(`/mcp/t/${KNOWN_TOKEN}`)).kind).toBe("rate_limited");

    expect(await app.request(`/mcp/t/${KNOWN_TOKEN}`, other)).toEqual({
      kind: "ok",
      principal: FAKE_PRINCIPAL,
    });
  });
});
