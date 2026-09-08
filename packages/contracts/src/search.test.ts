import { describe, expect, it } from "vitest";
import {
  ImageSearchHit,
  ImageSearchQuery,
  ImageSearchResponse,
  SearchHighlightRange,
  SearchHit,
  SearchQuery,
  SearchResponse,
  SearchSections,
  SearchSnippet,
  SearchStatusResponse,
} from "./search";

const VALID_HIT = {
  path: "/docs/readme.md",
  name: "readme.md",
  kind: "file",
  ext: ".md",
  mime: "text/markdown",
  size: 1024,
  modifiedAt: "2026-01-01T00:00:00.000Z",
  score: 1.23,
  snippets: [{ text: "hello world", ranges: [{ start: 0, end: 5 }] }],
  hasThumbnail: false,
};

describe("SearchHighlightRange", () => {
  it("parses a valid range", () => {
    expect(SearchHighlightRange.parse({ start: 0, end: 5 })).toEqual({ start: 0, end: 5 });
  });

  it("rejects a negative start", () => {
    expect(SearchHighlightRange.safeParse({ start: -1, end: 5 }).success).toBe(false);
  });
});

describe("SearchSnippet", () => {
  it("parses a snippet with ranges", () => {
    const snippet = { text: "hello", ranges: [{ start: 0, end: 5 }] };
    expect(SearchSnippet.parse(snippet)).toEqual(snippet);
  });

  it("accepts an empty ranges array", () => {
    expect(SearchSnippet.safeParse({ text: "hello", ranges: [] }).success).toBe(true);
  });
});

describe("SearchHit", () => {
  it("parses a valid hit", () => {
    expect(SearchHit.parse(VALID_HIT)).toEqual(VALID_HIT);
  });

  it("accepts a null mime", () => {
    expect(SearchHit.safeParse({ ...VALID_HIT, mime: null }).success).toBe(true);
  });

  it("rejects a negative size", () => {
    expect(SearchHit.safeParse({ ...VALID_HIT, size: -1 }).success).toBe(false);
  });
});

describe("SearchSections", () => {
  it("parses empty sections", () => {
    expect(SearchSections.parse({ folders: [], files: [], content: [] })).toEqual({
      folders: [],
      files: [],
      content: [],
    });
  });

  it("parses sections with hits", () => {
    const result = SearchSections.safeParse({ folders: [], files: [VALID_HIT], content: [] });
    expect(result.success).toBe(true);
  });
});

describe("SearchResponse", () => {
  const VALID_RESPONSE = {
    query: "readme",
    sections: { folders: [], files: [VALID_HIT], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 42,
  };

  it("parses a full response", () => {
    expect(SearchResponse.parse(VALID_RESPONSE)).toEqual(VALID_RESPONSE);
  });

  it("rejects a negative tookMs", () => {
    expect(SearchResponse.safeParse({ ...VALID_RESPONSE, tookMs: -1 }).success).toBe(false);
  });

  it("rejects a missing unavailable field", () => {
    const { unavailable, ...rest } = VALID_RESPONSE;
    expect(SearchResponse.safeParse(rest).success).toBe(false);
  });

  it("accepts an optional partial flag", () => {
    const result = SearchResponse.safeParse({ ...VALID_RESPONSE, partial: true });
    expect(result.success).toBe(true);
  });

  it("parses without a partial flag present at all", () => {
    const result = SearchResponse.safeParse(VALID_RESPONSE);
    expect(result.success && "partial" in result.data).toBe(false);
  });
});

describe("SearchQuery", () => {
  it("parses a query with only q", () => {
    expect(SearchQuery.parse({ q: "readme" })).toEqual({ q: "readme" });
  });

  it("rejects an empty q", () => {
    expect(SearchQuery.safeParse({ q: "" }).success).toBe(false);
  });

  it("parses every optional filter", () => {
    const query = {
      q: "readme",
      limit: "10",
      ext: "pdf",
      folder: "/docs",
      after: "2026-01-01",
      before: "2026-02-01",
    };
    expect(SearchQuery.parse(query)).toEqual(query);
  });
});

describe("SearchStatusResponse", () => {
  it("parses a fully available status", () => {
    expect(SearchStatusResponse.parse({ available: true, semantic: true, images: true })).toEqual({
      available: true,
      semantic: true,
      images: true,
    });
  });

  it("parses an unavailable status", () => {
    expect(
      SearchStatusResponse.safeParse({
        available: false,
        semantic: false,
        images: false,
        reason: "indexer_unreachable",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown unavailable reason", () => {
    expect(
      SearchStatusResponse.safeParse({
        available: false,
        semantic: false,
        reason: "not-a-reason",
      }).success,
    ).toBe(false);
  });

  it("parses a missing images field (an older API without image search)", () => {
    expect(SearchStatusResponse.safeParse({ available: true, semantic: true }).success).toBe(true);
  });
});

const VALID_IMAGE_HIT = {
  path: "/photos/cat.jpg",
  name: "cat.jpg",
  ext: "jpg",
  mime: "image/jpeg",
  size: 1024,
  modifiedAt: "2024-01-01T00:00:00.000Z",
  score: 0.82,
};

describe("ImageSearchHit", () => {
  it("parses a valid hit", () => {
    expect(ImageSearchHit.parse(VALID_IMAGE_HIT)).toEqual(VALID_IMAGE_HIT);
  });

  it("rejects a negative size", () => {
    expect(ImageSearchHit.safeParse({ ...VALID_IMAGE_HIT, size: -1 }).success).toBe(false);
  });

  it("allows a null mime", () => {
    expect(ImageSearchHit.safeParse({ ...VALID_IMAGE_HIT, mime: null }).success).toBe(true);
  });
});

describe("ImageSearchResponse", () => {
  it("parses a full response", () => {
    const response = {
      query: "cat",
      hits: [VALID_IMAGE_HIT],
      unavailable: false,
      partial: true,
      tookMs: 12,
    };
    expect(ImageSearchResponse.parse(response)).toEqual(response);
  });

  it("parses a response without partial", () => {
    const response = { query: "cat", hits: [], unavailable: true, tookMs: 0 };
    expect(ImageSearchResponse.safeParse(response).success).toBe(true);
  });

  it("rejects a negative tookMs", () => {
    expect(
      ImageSearchResponse.safeParse({
        query: "cat",
        hits: [],
        unavailable: false,
        tookMs: -1,
      }).success,
    ).toBe(false);
  });
});

describe("ImageSearchQuery", () => {
  it("parses q with an optional limit", () => {
    expect(ImageSearchQuery.parse({ q: "cat", limit: "10" })).toEqual({ q: "cat", limit: "10" });
  });

  it("rejects an empty q", () => {
    expect(ImageSearchQuery.safeParse({ q: "" }).success).toBe(false);
  });
});
