import type { Scope } from "@fdrive/core";
import type { ImageSearchHit as DbImageSearchHit, IndexQueries } from "@fdrive/db";
import { describe, expect, it } from "vitest";
import type {
  ReadAuthorizeReason,
  ReadAuthorizer,
  ReadAuthorizeTarget,
} from "../scoping/read-authorizer.ts";
import type { SidecarResult } from "../system/sidecar-client.js";
import type { ImageEmbedClient, ImageEmbedHealthInfo } from "./image-embed-client.js";
import {
  createImageSearchService,
  IMAGE_EMBED_DIM,
  IMAGE_SCORE_RATIO,
  IMAGE_SEARCH_FANOUT_LIMIT,
  type ImageSearchServiceDeps,
  type ImageSearchServiceInput,
  selectImageHits,
} from "./image-service.js";

const HOME_SCOPES: readonly Scope[] = [
  { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
];
const NOW = new Date("2026-03-01T00:00:00.000Z");

it("stops image search immediately when disabled", async () => {
  const service = createImageSearchService(buildDeps({ enabled: async () => false }));
  expect(await service.search(buildInput())).toMatchObject({ unavailable: true });
});
const HEALTHY: ImageEmbedHealthInfo = {
  status: "ok",
  model: "google/siglip2-large-patch16-256",
  dim: IMAGE_EMBED_DIM,
  device: "cpu",
};

function fail(name: string): never {
  throw new Error(`unexpected call to ${name} in this test`);
}

function fakeIndexQueries(
  overrides: Partial<Pick<IndexQueries, "searchImages" | "rootIdsByName">> = {},
): Pick<IndexQueries, "searchImages" | "rootIdsByName"> {
  return {
    rootIdsByName: overrides.rootIdsByName ?? (async () => ({ sftpgo: 1 })),
    searchImages: overrides.searchImages ?? (async () => fail("searchImages")),
  };
}

function fakeAuthorizer(
  opts: {
    readonly denied?: ReadonlySet<string>;
    readonly unavailable?: ReadonlySet<string>;
    readonly calls?: ReadAuthorizeTarget[];
  } = {},
): ReadAuthorizer {
  return {
    async authorize(target) {
      opts.calls?.push(target);
      const key = `${target.kind}:${target.path}`;
      if (opts.unavailable?.has(key) === true) {
        return { allowed: false, reason: "unavailable" satisfies ReadAuthorizeReason };
      }
      if (opts.denied?.has(key) === true) {
        return { allowed: false, reason: "denied" satisfies ReadAuthorizeReason };
      }
      return { allowed: true };
    },
  };
}

function fakeImageEmbedClient(overrides: Partial<ImageEmbedClient> = {}): ImageEmbedClient {
  return {
    health: overrides.health ?? (async () => fail("health")),
    embedText: overrides.embedText ?? (async () => ({ vector: [1, 0], model: HEALTHY.model })),
  };
}

function healthyResolver(
  health: ImageEmbedHealthInfo = HEALTHY,
): () => Promise<SidecarResult<ImageEmbedHealthInfo> | null> {
  return async () => ({ ok: true, data: health });
}

function makeRow(overrides: Partial<DbImageSearchHit> = {}): DbImageSearchHit {
  return {
    rootId: 1,
    path: "alice/cat.jpg",
    size: 1024,
    modifiedAt: NOW,
    score: 0.9,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<ImageSearchServiceDeps> = {}): ImageSearchServiceDeps {
  return {
    indexQueries: fakeIndexQueries(),
    imageEmbedClient: fakeImageEmbedClient(),
    resolveHealth: healthyResolver(),
    trashPath: null,
    clock: () => NOW,
    ...overrides,
  };
}

function buildInput(overrides: Partial<ImageSearchServiceInput> = {}): ImageSearchServiceInput {
  return {
    scopes: HOME_SCOPES,
    authorizer: fakeAuthorizer(),
    query: "blue chair",
    limit: 20,
    ...overrides,
  };
}

describe("selectImageHits", () => {
  it("returns an empty array for no rows", () => {
    expect(selectImageHits([], 10)).toEqual([]);
  });

  it("keeps only the top `limit` rows when the best score is zero", () => {
    const rows = [{ score: 0 }, { score: 0 }, { score: 0 }];
    expect(selectImageHits(rows, 2)).toEqual([{ score: 0 }, { score: 0 }]);
  });

  it("keeps only the top `limit` rows when the best score is negative", () => {
    const rows = [{ score: -0.1 }, { score: -0.2 }, { score: -0.3 }];
    expect(selectImageHits(rows, 1)).toEqual([{ score: -0.1 }]);
  });

  it("drops rows below best * IMAGE_SCORE_RATIO when the best score is positive", () => {
    const best = 1;
    const threshold = best * IMAGE_SCORE_RATIO;
    const rows = [
      { score: best },
      { score: threshold }, // exactly at the threshold: kept
      { score: threshold - 0.001 }, // just below: dropped
    ];
    expect(selectImageHits(rows, 10)).toEqual([{ score: best }, { score: threshold }]);
  });

  it("caps the ratio-filtered result at limit", () => {
    const rows = [{ score: 1 }, { score: 0.9 }, { score: 0.8 }];
    expect(selectImageHits(rows, 1)).toEqual([{ score: 1 }]);
  });
});

describe("createImageSearchService", () => {
  it("reports unavailable when the caller has no scopes", async () => {
    const service = createImageSearchService(buildDeps());
    const result = await service.search(buildInput({ scopes: [] }));

    expect(result).toEqual({ query: "blue chair", hits: [], unavailable: true, tookMs: 0 });
  });

  it("reports unavailable when image search is not configured", async () => {
    const service = createImageSearchService(
      buildDeps({ imageEmbedClient: null, resolveHealth: async () => null }),
    );
    const result = await service.search(buildInput());

    expect(result.unavailable).toBe(true);
    expect(result.hits).toEqual([]);
  });

  it("reports unavailable when the sidecar health probe fails", async () => {
    const service = createImageSearchService(
      buildDeps({
        resolveHealth: async () => ({ ok: false, reason: "unreachable", detail: "down" }),
      }),
    );
    const result = await service.search(buildInput());

    expect(result.unavailable).toBe(true);
  });

  it("reports unavailable when the sidecar is still loading (status !== ok)", async () => {
    const service = createImageSearchService(
      buildDeps({ resolveHealth: healthyResolver({ ...HEALTHY, status: "loading", dim: null }) }),
    );
    const result = await service.search(buildInput());

    expect(result.unavailable).toBe(true);
  });

  it("reports unavailable when the sidecar's dim does not match IMAGE_EMBED_DIM", async () => {
    const service = createImageSearchService(
      buildDeps({ resolveHealth: healthyResolver({ ...HEALTHY, dim: 512 }) }),
    );
    const result = await service.search(buildInput());

    expect(result.unavailable).toBe(true);
  });

  it("reports unavailable when none of the caller's scopes map to a known root", async () => {
    const service = createImageSearchService(
      buildDeps({ indexQueries: fakeIndexQueries({ rootIdsByName: async () => ({}) }) }),
    );
    const result = await service.search(buildInput());

    expect(result.unavailable).toBe(true);
  });

  it("reports unavailable when the sidecar returns no embedding for this query", async () => {
    const service = createImageSearchService(
      buildDeps({ imageEmbedClient: fakeImageEmbedClient({ embedText: async () => null }) }),
    );
    const result = await service.search(buildInput());

    expect(result.unavailable).toBe(true);
  });

  it("passes the sidecar's model id (not a stale one) to searchImages", async () => {
    let receivedModel: string | undefined;
    const indexQueries = fakeIndexQueries({
      searchImages: async (_prefixes, _vector, model) => {
        receivedModel = model;
        return [];
      },
    });
    const service = createImageSearchService(buildDeps({ indexQueries }));

    await service.search(buildInput());

    expect(receivedModel).toBe(HEALTHY.model);
  });

  it("resolves, authorizes, and returns hits round-tripped through the caller's scope", async () => {
    const indexQueries = fakeIndexQueries({
      searchImages: async () => [makeRow({ path: "alice/cat.jpg", score: 0.9 })],
    });
    const service = createImageSearchService(buildDeps({ indexQueries }));

    const result = await service.search(buildInput());

    expect(result.unavailable).toBe(false);
    expect(result.hits).toEqual([
      {
        path: "/cat.jpg",
        name: "cat.jpg",
        ext: ".jpg",
        mime: "image/jpeg",
        size: 1024,
        modifiedAt: NOW.toISOString(),
        score: 0.9,
      },
    ]);
  });

  it("excludes a row whose path does not round-trip (out of scope)", async () => {
    const indexQueries = fakeIndexQueries({
      searchImages: async () => [makeRow({ path: "bob/cat.jpg" })],
    });
    const service = createImageSearchService(buildDeps({ indexQueries }));

    const result = await service.search(buildInput());

    expect(result.hits).toEqual([]);
  });

  it("excludes a row under the trash path", async () => {
    const indexQueries = fakeIndexQueries({
      searchImages: async () => [makeRow({ path: "alice/.trash/cat.jpg" })],
    });
    const service = createImageSearchService(buildDeps({ indexQueries, trashPath: "/.trash" }));

    const result = await service.search(buildInput());

    expect(result.hits).toEqual([]);
  });

  it("excludes a row the authorizer denies, without marking partial", async () => {
    const indexQueries = fakeIndexQueries({
      searchImages: async () => [makeRow({ path: "alice/cat.jpg" })],
    });
    const service = createImageSearchService(buildDeps({ indexQueries }));
    const authorizer = fakeAuthorizer({ denied: new Set(["file:/cat.jpg"]) });

    const result = await service.search(buildInput({ authorizer }));

    expect(result.hits).toEqual([]);
    expect(result.partial).toBeUndefined();
  });

  it("marks partial when the authorizer reports unavailable for a candidate", async () => {
    const indexQueries = fakeIndexQueries({
      searchImages: async () => [makeRow({ path: "alice/cat.jpg" })],
    });
    const service = createImageSearchService(buildDeps({ indexQueries }));
    const authorizer = fakeAuthorizer({ unavailable: new Set(["file:/cat.jpg"]) });

    const result = await service.search(buildInput({ authorizer }));

    expect(result.hits).toEqual([]);
    expect(result.partial).toBe(true);
  });

  it("marks partial when the fanout limit was exhausted", async () => {
    const rows = Array.from({ length: IMAGE_SEARCH_FANOUT_LIMIT }, (_, n) =>
      makeRow({ path: `alice/cat${n}.jpg`, score: 1 - n * 0.001 }),
    );
    const indexQueries = fakeIndexQueries({ searchImages: async () => rows });
    const service = createImageSearchService(buildDeps({ indexQueries }));

    const result = await service.search(buildInput({ limit: 50 }));

    expect(result.partial).toBe(true);
  });

  it("does not mark partial for an exhaustive response", async () => {
    const indexQueries = fakeIndexQueries({
      searchImages: async () => [makeRow({ path: "alice/cat.jpg" })],
    });
    const service = createImageSearchService(buildDeps({ indexQueries }));

    const result = await service.search(buildInput());

    expect(result.partial).toBeUndefined();
  });

  it("reports elapsed time via the clock", async () => {
    let now = NOW.getTime();
    const clock = () => new Date(now++);
    const indexQueries = fakeIndexQueries({ searchImages: async () => [] });
    const service = createImageSearchService(buildDeps({ indexQueries, clock }));

    const result = await service.search(buildInput());

    expect(result.tookMs).toBeGreaterThan(0);
  });
});
