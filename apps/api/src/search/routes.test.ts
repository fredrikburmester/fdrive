import type { SearchResponse, SearchStatusResponse } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  parseSearchLimit,
  registerSearchRoutes,
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

function notImplemented(): never {
  throw new Error("not used in this test");
}

function buildApp(searchService: SearchService, username = "alice") {
  const storage = {} as StorageProvider;
  const principal: Principal = {
    accountId: "00000000-0000-4000-8000-000000000001",
    identityId: "00000000-0000-4000-8000-0000000000a1",
    username,
    storage,
    isAdmin: false,
  };

  return createApp({
    config: loadConfig(REQUIRED_ENV),
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date("2024-06-01T00:00:00.000Z"),
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerSearchRoutes(groups, { searchService }),
  });
}

function fakeSearchService(overrides: Partial<SearchService> = {}): SearchService {
  return {
    search: overrides.search ?? (async () => notImplemented()),
    status: overrides.status ?? notImplemented,
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

  it("passes the identity's username, query, filters, and limit to the service", async () => {
    let received: SearchServiceInput | undefined;
    const search = vi.fn(async (input: SearchServiceInput) => {
      received = input;
      return { ...EMPTY_RESPONSE, query: input.query };
    });
    const app = buildApp(fakeSearchService({ search }), "alice");

    const res = await app.request(
      "/api/v1/search?q=readme&limit=5&ext=pdf&folder=%2Fdocs&after=2026-01-01&before=2026-02-01",
    );

    expect(res.status).toBe(200);
    expect(received).toEqual({
      username: "alice",
      query: "readme",
      filters: {
        exts: [".pdf"],
        folder: "/docs",
        after: new Date("2026-01-01"),
        before: new Date("2026-02-01"),
      },
      limit: 5,
    });
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
  it("returns the service's status", async () => {
    const status = vi.fn((): SearchStatusResponse => ({ available: true, semantic: false }));
    const app = buildApp(fakeSearchService({ status }));

    const res = await app.request("/api/v1/search/status");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ available: true, semantic: false });
  });
});
