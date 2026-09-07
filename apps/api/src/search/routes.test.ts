import type { SearchResponse } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Identity } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { buildIdentity } from "../scoping/test-fixtures/index.ts";
import type { ScopeStatus } from "../scoping/types.ts";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  parseSearchLimit,
  registerSearchRoutes,
  type SearchRoutesDeps,
} from "./routes.js";
import type { SearchService, SearchServiceInput } from "./service.js";

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

const EMPTY_RESPONSE: SearchResponse = {
  query: "",
  sections: { folders: [], files: [], content: [] },
  degraded: false,
  unavailable: false,
  tookMs: 1,
};

const IDENTITY: Identity = buildIdentity({ id: "00000000-0000-4000-8000-0000000000a1" });

const AVAILABLE_STATUS: ScopeStatus = {
  status: "available",
  reason: "ok",
  usesOverride: false,
  virtualPrefixes: ["/"],
  warning: "warning",
  isAdmin: false,
};

function notImplemented(): never {
  throw new Error("not used in this test");
}

function fakeResolver(overrides: Partial<SearchRoutesDeps["resolver"]> = {}) {
  return {
    verifiedIndexScopes:
      overrides.verifiedIndexScopes ?? (async () => ({ available: true as const, scopes: [] })),
    status: overrides.status ?? (async () => AVAILABLE_STATUS),
  };
}

function buildApp(
  searchService: SearchService,
  overrides: {
    readonly resolver?: SearchRoutesDeps["resolver"];
    readonly identity?: Identity | null;
    readonly semanticEnabled?: boolean;
    readonly principal?: Partial<Principal>;
  } = {},
) {
  const storage = {} as StorageProvider;
  const principal: Principal = {
    accountId: "00000000-0000-4000-8000-000000000001",
    identityId: "00000000-0000-4000-8000-0000000000a1",
    username: "alice",
    storage,
    isAdmin: false,
    ...overrides.principal,
  };
  const identity = overrides.identity === undefined ? IDENTITY : overrides.identity;

  return createApp({
    config: loadConfig(REQUIRED_ENV),
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date("2024-06-01T00:00:00.000Z"),
    principalResolver: async () => principal,
    registerRoutes: (groups) =>
      registerSearchRoutes(groups, {
        searchService,
        resolver: overrides.resolver ?? fakeResolver(),
        identities: { get: async () => identity },
        semanticEnabled: overrides.semanticEnabled ?? false,
      }),
  });
}

function fakeSearchService(overrides: Partial<SearchService> = {}): SearchService {
  return {
    search: overrides.search ?? (async () => notImplemented()),
  };
}

describe("parseSearchLimit", () => {
  it("defaults to 20 when absent", () => {
    expect(parseSearchLimit(undefined)).toBe(DEFAULT_SEARCH_LIMIT);
  });

  it("parses a valid integer", () => {
    expect(parseSearchLimit("5")).toBe(5);
  });

  it("defaults for a non-numeric value", () => {
    expect(parseSearchLimit("abc")).toBe(DEFAULT_SEARCH_LIMIT);
  });

  it("defaults for a non-integer value", () => {
    expect(parseSearchLimit("2.5")).toBe(DEFAULT_SEARCH_LIMIT);
  });

  it("clamps to the maximum", () => {
    expect(parseSearchLimit("1000")).toBe(MAX_SEARCH_LIMIT);
  });

  it("clamps a value below 1 up to 1", () => {
    expect(parseSearchLimit("0")).toBe(1);
    expect(parseSearchLimit("-5")).toBe(1);
  });
});

describe("GET /api/v1/search", () => {
  it("returns 400 for an empty q", async () => {
    const app = buildApp(fakeSearchService());

    const res = await app.request("/api/v1/search?q=");

    expect(res.status).toBe(400);
  });

  it("returns 400 for a missing q", async () => {
    const app = buildApp(fakeSearchService());

    const res = await app.request("/api/v1/search");

    expect(res.status).toBe(400);
  });

  it("passes the identity's verified scopes, query, filters, and limit to the service", async () => {
    let received: SearchServiceInput | undefined;
    const search = vi.fn(async (input: SearchServiceInput) => {
      received = input;
      return { ...EMPTY_RESPONSE, query: input.query };
    });
    const scopes = [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }];
    const app = buildApp(fakeSearchService({ search }), {
      resolver: fakeResolver({ verifiedIndexScopes: async () => ({ available: true, scopes }) }),
    });

    const res = await app.request(
      "/api/v1/search?q=readme&limit=5&ext=pdf&folder=%2Fdocs&after=2026-01-01&before=2026-02-01",
    );

    expect(res.status).toBe(200);
    expect(received?.scopes).toEqual(scopes);
    expect(received?.query).toBe("readme");
    expect(received?.filters).toEqual({
      exts: [".pdf"],
      folder: "/docs",
      after: new Date("2026-01-01"),
      before: new Date("2026-02-01"),
    });
    expect(received?.limit).toBe(5);
    expect(received?.authorizer).toBeDefined();
  });

  it("passes an empty scope list when the identity's verified scopes are unavailable", async () => {
    let received: SearchServiceInput | undefined;
    const search = vi.fn(async (input: SearchServiceInput) => {
      received = input;
      return EMPTY_RESPONSE;
    });
    const app = buildApp(fakeSearchService({ search }), {
      resolver: fakeResolver({
        verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }),
      }),
    });

    await app.request("/api/v1/search?q=readme");

    expect(received?.scopes).toEqual([]);
  });

  it("passes an empty scope list when the caller's identity no longer exists", async () => {
    let received: SearchServiceInput | undefined;
    const search = vi.fn(async (input: SearchServiceInput) => {
      received = input;
      return EMPTY_RESPONSE;
    });
    const app = buildApp(fakeSearchService({ search }), { identity: null });

    await app.request("/api/v1/search?q=readme");

    expect(received?.scopes).toEqual([]);
  });

  it("returns the service's response as JSON", async () => {
    const search = vi.fn(async () => ({ ...EMPTY_RESPONSE, query: "readme" }));
    const app = buildApp(fakeSearchService({ search }));

    const res = await app.request("/api/v1/search?q=readme");
    const body = await res.json();

    expect(body).toEqual({ ...EMPTY_RESPONSE, query: "readme" });
  });

  it("uses the default limit when none is given", async () => {
    let received: SearchServiceInput | undefined;
    const search = vi.fn(async (input: SearchServiceInput) => {
      received = input;
      return EMPTY_RESPONSE;
    });
    const app = buildApp(fakeSearchService({ search }));

    await app.request("/api/v1/search?q=readme");

    expect(received?.limit).toBe(DEFAULT_SEARCH_LIMIT);
  });
});

describe("GET /api/v1/search/status", () => {
  it("reports available when the resolver reports available", async () => {
    const app = buildApp(fakeSearchService(), {
      resolver: fakeResolver({ status: async () => AVAILABLE_STATUS }),
      semanticEnabled: true,
    });

    const res = await app.request("/api/v1/search/status");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ available: true, semantic: true });
  });

  it("reports unavailable when the resolver reports unavailable", async () => {
    const app = buildApp(fakeSearchService(), {
      resolver: fakeResolver({
        status: async () => ({ ...AVAILABLE_STATUS, status: "unavailable", reason: "no_roots" }),
      }),
    });

    const res = await app.request("/api/v1/search/status");
    const body = await res.json();

    expect(body).toEqual({ available: false, semantic: false });
  });

  it("reports unavailable when the caller's identity no longer exists", async () => {
    const app = buildApp(fakeSearchService(), { identity: null });

    const res = await app.request("/api/v1/search/status");
    const body = await res.json();

    expect(body).toEqual({ available: false, semantic: false });
  });
});
