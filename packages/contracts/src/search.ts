import { z } from "zod";
import { EntryKind, FsEntry } from "./fs.ts";
import { IdentityScopeReason } from "./scopes.ts";

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
 * home is not on one); `sections` is empty in that case. `partial`, when
 * present and true, means the response omits some matches that could not
 * be confirmed accessible (a live permission check reported "unavailable"
 * rather than granted or denied) or that the bounded internal fanout was
 * exhausted before every match could be considered; it is never present
 * (rather than `false`) on an exhaustive response.
 */
export const SearchResponse = z.object({
  query: z.string(),
  sections: SearchSections,
  degraded: z.boolean(),
  unavailable: z.boolean(),
  partial: z.boolean().optional(),
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
  /**
   * Why the active identity cannot use its index-backed scope. Omitted for
   * available scopes and for older servers that do not expose a reason.
   */
  reason: IdentityScopeReason.optional(),
  /**
   * Whether image-content search (`FDRIVE_IMAGE_EMBED_URL`) is configured.
   * Optional (rather than required) so a client built against an older
   * contract version still parses a response from a newer API, and vice
   * versa.
   */
  images: z.boolean().optional(),
});

export type SearchStatusResponse = z.infer<typeof SearchStatusResponse>;

/**
 * One image-content search result: a file whose thumbnail was embedded and
 * matched by cosine similarity to the query text's embedding. There are no
 * snippets (no matched text to excerpt) and a thumbnail is always assumed to
 * be present, since the row only exists because a thumbnail was embedded.
 */
export const ImageSearchHit = z.object({
  path: z.string(),
  name: z.string(),
  ext: z.string(),
  mime: z.string().nullable(),
  size: z.number().int().min(0),
  modifiedAt: z.iso.datetime(),
  score: z.number(),
});

export type ImageSearchHit = z.infer<typeof ImageSearchHit>;

/**
 * The response to `GET /api/v1/search/images`. `unavailable` is true when
 * the caller has no verified index scope, image search is not configured, or
 * the sidecar did not return an embedding for the query (a text-embed
 * failure is not "degraded"; there is no keyword fallback for images).
 * `partial`, when present and true, means the bounded internal fanout was
 * exhausted before every match could be considered, or a live permission
 * check reported "unavailable" for some candidate.
 */
export const ImageSearchResponse = z.object({
  query: z.string(),
  hits: z.array(ImageSearchHit),
  unavailable: z.boolean(),
  partial: z.boolean().optional(),
  tookMs: z.number().int().min(0),
});

export type ImageSearchResponse = z.infer<typeof ImageSearchResponse>;

/** Query parameters for `GET /api/v1/search/images`. Every field arrives as a raw string. */
export const ImageSearchQuery = z.object({
  q: z.string().min(1, "q must not be empty"),
  limit: z.string().optional(),
});

export type ImageSearchQuery = z.infer<typeof ImageSearchQuery>;
