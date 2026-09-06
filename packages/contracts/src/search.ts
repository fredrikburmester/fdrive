import { z } from "zod";
import { EntryKind, FsEntry } from "./fs.ts";

/** A `[start, end)` character range to highlight within a snippet's text. */
export const SearchHighlightRange = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});

export type SearchHighlightRange = z.infer<typeof SearchHighlightRange>;

/** One excerpt of matched content, with the ranges to render as `<mark>`. */
export const SearchSnippet = z.object({
  text: z.string(),
  ranges: z.array(SearchHighlightRange),
});

export type SearchSnippet = z.infer<typeof SearchSnippet>;

/** One search result: a file (never a folder; folders have their own section). */
export const SearchHit = z.object({
  path: z.string(),
  name: z.string(),
  kind: EntryKind,
  ext: z.string(),
  mime: z.string().nullable(),
  size: z.number().int().min(0),
  modifiedAt: z.iso.datetime(),
  score: z.number(),
  snippets: z.array(SearchSnippet),
  hasThumbnail: z.boolean(),
});

export type SearchHit = z.infer<typeof SearchHit>;

/** The sectioned results the search panel renders: folders, filename matches, content matches. */
export const SearchSections = z.object({
  folders: z.array(FsEntry),
  files: z.array(SearchHit),
  content: z.array(SearchHit),
});

export type SearchSections = z.infer<typeof SearchSections>;

/**
 * The response to `GET /api/v1/search`. `degraded` is true when semantic
 * search could not run (the embedding service is unreachable) and results
 * are keyword-only. `unavailable` is true when the caller has no
 * index-backed scope at all (no configured index roots, or the identity's
 * home is not on one); `sections` is empty in that case.
 */
export const SearchResponse = z.object({
  query: z.string(),
  sections: SearchSections,
  degraded: z.boolean(),
  unavailable: z.boolean(),
  tookMs: z.number().int().min(0),
});

export type SearchResponse = z.infer<typeof SearchResponse>;

/** Query parameters for `GET /api/v1/search`. Every field arrives as a raw string. */
export const SearchQuery = z.object({
  q: z.string().min(1, "q must not be empty"),
  limit: z.string().optional(),
  ext: z.string().optional(),
  folder: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
});

export type SearchQuery = z.infer<typeof SearchQuery>;

/** Response for `GET /api/v1/search/status`. */
export const SearchStatusResponse = z.object({
  available: z.boolean(),
  semantic: z.boolean(),
});

export type SearchStatusResponse = z.infer<typeof SearchStatusResponse>;
