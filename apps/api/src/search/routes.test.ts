import type { ImageSearchResponse, SearchResponse } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import type { ImageSearchService, ImageSearchServiceInput } from "./image-service.js";
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
  FDRIVE_STORAGE_ROOT: "/srv/files",
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

const EMPTY_IMAGE_RESPONSE: ImageSearchResponse = {
  query: "",
  hits: [],
  unavailable: false,
  tookMs: 1,
};

function notImplemented(): never {
  throw new Error("not used in this test");
}

function fakeResolver(overrides: Partial<SearchRoutesDeps["resolver"]> = {}) {
  return { scopesFor: overrides.scopesFor ?? (async () => []) };
}

function buildApp(
  searchService: SearchService,
  overrides: {
    readonly features?: SearchRoutesDeps["features"];
    readonly resolver?: SearchRoutesDeps["resolver"];
    readonly indexerConfigured?: boolean;
    readonly semanticEnabled?: boolean;
    readonly imageSearchEnabled?: boolean;
    readonly principal?: Partial<Principal>;
    readonly imageSearchService?: ImageSearchService;
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

  return createApp({
    config: loadConfig(REQUIRED_ENV),
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date("2024-06-01T00:00:00.000Z"),
    principalResolver: async () => principal,
    setupRequired: async () => false,
    registerRoutes: (groups) =>
      registerSearchRoutes(groups, {
        ...(overrides.features === undefined ? {} : { features: overrides.features }),
        searchService,
        imageSearchService: overrides.imageSearchService ?? fakeImageSearchService(),
        resolver: overrides.resolver ?? fakeResolver(),
        indexerConfigured: overrides.indexerConfigured ?? true,
        semanticEnabled: overrides.semanticEnabled ?? false,
        imageSearchEnabled: overrides.imageSearchEnabled ?? false,
      }),
  });
}

function fakeSearchService(overrides: Partial<SearchService> = {}): SearchService {
  return {
    search: overrides.search ?? (async () => notImplemented()),
  };
}

function fakeImageSearchService(overrides: Partial<ImageSearchService> = {}): ImageSearchService {
  return {
    search: overrides.search ?? (async () => EMPTY_IMAGE_RESPONSE),
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
  it("reports disabled feature choices even when the storage scope is available", async () => {
    const app = buildApp(fakeSearchService(), {
      semanticEnabled: true,
      imageSearchEnabled: true,
      features: async () => ({ textSearch: false, semanticSearch: false, imageSearch: false }),
    });
    expect(await (await app.request("/api/v1/search/status")).json()).toMatchObject({
      available: false,
      semantic: false,
      images: false,
    });
  });
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

  it("passes the login's scopes, query, filters, and limit to the service", async () => {
    let received: SearchServiceInput | undefined;
    const search = vi.fn(async (input: SearchServiceInput) => {
      received = input;
      return { ...EMPTY_RESPONSE, query: input.query };
    });
    const scopes = [{ fsPrefix: "/alice", virtualPrefix: "/" }];
    const scopesFor = vi.fn(async (_username: string) => scopes);
    const app = buildApp(fakeSearchService({ search }), {
      resolver: fakeResolver({ scopesFor }),
    });

    const res = await app.request(
      "/api/v1/search?q=readme&limit=5&ext=pdf&folder=%2Fdocs&after=2026-01-01&before=2026-02-01",
    );

    expect(res.status).toBe(200);
    // Resolved for this request from the principal's own username.
    expect(scopesFor).toHaveBeenCalledExactlyOnceWith("alice");
    expect(received?.scopes).toEqual(scopes);
    expect(received?.query).toBe("readme");
    expect(received?.filters).toEqual({
      exts: [".pdf"],
      folder: "/docs",
      after: new Date("2026-01-01"),
      before: new Date("2026-02-01"),
    });
    expect(received?.limit).toBe(5);
  });

  it("passes an empty scope list without an indexer", async () => {
    let received: SearchServiceInput | undefined;
    const search = vi.fn(async (input: SearchServiceInput) => {
      received = input;
      return EMPTY_RESPONSE;
    });
    const app = buildApp(fakeSearchService({ search }), {
      indexerConfigured: false,
    });

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

describe("GET /api/v1/search/images", () => {
  it("returns 400 for an empty q", async () => {
    const app = buildApp(fakeSearchService());

    const res = await app.request("/api/v1/search/images?q=");

    expect(res.status).toBe(400);
  });

  it("returns 400 for a missing q", async () => {
    const app = buildApp(fakeSearchService());

    const res = await app.request("/api/v1/search/images");

    expect(res.status).toBe(400);
  });

  it("passes the identity's scopes, query, and limit to the service", async () => {
    let received: ImageSearchServiceInput | undefined;
    const search = vi.fn(async (input: ImageSearchServiceInput) => {
      received = input;
      return { ...EMPTY_IMAGE_RESPONSE, query: input.query };
    });
    const scopes = [{ fsPrefix: "/alice", virtualPrefix: "/" }];
    const app = buildApp(fakeSearchService(), {
      resolver: fakeResolver({ scopesFor: async () => scopes }),
      imageSearchService: fakeImageSearchService({ search }),
    });

    const res = await app.request("/api/v1/search/images?q=cat&limit=5");

    expect(res.status).toBe(200);
    expect(received?.scopes).toEqual(scopes);
    expect(received?.query).toBe("cat");
    expect(received?.limit).toBe(5);
  });

  it("passes an empty scope list without an indexer", async () => {
    let received: ImageSearchServiceInput | undefined;
    const search = vi.fn(async (input: ImageSearchServiceInput) => {
      received = input;
      return EMPTY_IMAGE_RESPONSE;
    });
    const app = buildApp(fakeSearchService(), {
      indexerConfigured: false,
      imageSearchService: fakeImageSearchService({ search }),
    });

    await app.request("/api/v1/search/images?q=cat");

    expect(received?.scopes).toEqual([]);
  });

  it("returns the service's response as JSON", async () => {
    const search = vi.fn(async () => ({ ...EMPTY_IMAGE_RESPONSE, query: "cat" }));
    const app = buildApp(fakeSearchService(), {
      imageSearchService: fakeImageSearchService({ search }),
    });

    const res = await app.request("/api/v1/search/images?q=cat");
    const body = await res.json();

    expect(body).toEqual({ ...EMPTY_IMAGE_RESPONSE, query: "cat" });
  });

  it("uses the default limit when none is given", async () => {
    let received: ImageSearchServiceInput | undefined;
    const search = vi.fn(async (input: ImageSearchServiceInput) => {
      received = input;
      return EMPTY_IMAGE_RESPONSE;
    });
    const app = buildApp(fakeSearchService(), {
      imageSearchService: fakeImageSearchService({ search }),
    });

    await app.request("/api/v1/search/images?q=cat");

    expect(received?.limit).toBe(DEFAULT_SEARCH_LIMIT);
  });
});

describe("GET /api/v1/search/status", () => {
  it("reports available while the indexer is configured", async () => {
    const app = buildApp(fakeSearchService(), {
      resolver: fakeResolver(),
      semanticEnabled: true,
      imageSearchEnabled: true,
    });

    const res = await app.request("/api/v1/search/status");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ available: true, semantic: true, images: true });
  });

  it("reports unavailable, and why, without an indexer", async () => {
    const app = buildApp(fakeSearchService(), { indexerConfigured: false });

    const res = await app.request("/api/v1/search/status");
    const body = await res.json();

    expect(body).toEqual({
      available: false,
      semantic: false,
      images: false,
      reason: "not_indexed",
    });
  });
});
