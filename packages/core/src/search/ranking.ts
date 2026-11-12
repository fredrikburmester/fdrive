/** Default reciprocal-rank-fusion constant, matching filesai's `k = 60.0`. */
export const DEFAULT_FUSION_K = 60;

/** One row from a ranked list going into `fuseRankings`. */
export interface RankedItem<Id> {
  readonly id: Id;
  /** An excerpt of the matched content, when the list carries one. */
  readonly snippet?: string;
}

/** One id's fused result: its combined score and up to two merged snippets. */
export interface FusedResult<Id> {
  readonly id: Id;
  readonly score: number;
  readonly snippets: readonly string[];
}

/** No result carries more than this many snippets, across every source list. */
const MAX_SNIPPETS_PER_ID = 2;

/**
 * Reciprocal rank fusion over one or more already-ranked lists, matching
 * filesai's `search`: within each list, an id's rank is the 1-based
 * position of its first occurrence among the list's *distinct* ids (a
 * repeated id, e.g. a second chunk of the same file, does not add to the
 * score again). Each list contributes `1 / (k + rank)` to the id's total
 * score, so an id present in every list scores higher than one seen only
 * once. Snippets are collected in list order and capped at two per id,
 * across all lists combined, mirroring filesai's shared snippet cap.
 *
 * Returns every id seen in any list, sorted by score descending; ties keep
 * the order the id was first encountered (JS's stable sort plus insertion
 * order iteration reproduces Python's stable sort over dict insertion
 * order).
 */
export function fuseRankings<Id>(
  lists: ReadonlyArray<ReadonlyArray<RankedItem<Id>>>,
  k: number = DEFAULT_FUSION_K,
): FusedResult<Id>[] {
  const scores = new Map<Id, number>();
  const snippets = new Map<Id, string[]>();

  for (const list of lists) {
    const seen = new Set<Id>();
    for (const item of list) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        const rank = seen.size;
        scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank));
      }
      if (item.snippet !== undefined) {
        const list2 = snippets.get(item.id) ?? [];
        if (list2.length < MAX_SNIPPETS_PER_ID) {
          list2.push(item.snippet);
        }
        snippets.set(item.id, list2);
      }
    }
  }

  const results: FusedResult<Id>[] = Array.from(scores.entries()).map(([id, score]) => ({
    id,
    score,
    snippets: snippets.get(id) ?? [],
  }));

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * The score contribution of one filename-search hit, matching filesai's
 * formula: `hits` is how many query words matched the path (ILIKE), `words`
 * is the total number of query words considered, `rank` is the 1-based
 * position of this row in the filename query's own result order (by hit
 * count, then trigram similarity), and `k` is the same fusion constant as
 * `fuseRankings`. The `1.5` factor lets a strong filename match outrank a
 * weak content match; `0.6 + 0.4 * hits / words` keeps a partial word match
 * from scoring as high as a full one.
 */
export function filenameScore(hits: number, words: number, rank: number, k: number): number {
  const wordFraction = words > 0 ? hits / words : 0;
  return ((0.6 + 0.4 * wordFraction) * 1.5) / (k + rank);
}

/** How well a file's name answers a query, strongest first; see `nameMatch`. */
export type NameMatch = "exact" | "words" | "path" | "none";

/**
 * What each `NameMatch` adds to a result's score. Reciprocal rank fusion
 * tops out near `0.05`, so any name match outranks every result found by
 * content alone, and a whole step separates one kind of name match from the
 * next.
 */
export const NAME_MATCH_BOOST: Readonly<Record<NameMatch, number>> = {
  exact: 3,
  words: 2,
  path: 1,
  none: 0,
};

/** The part of a file a query is compared with by `nameMatch`. */
export interface NameMatchTarget {
  readonly name: string;
  /** The folder holding the file, as the caller sees it. */
  readonly folder: string;
}

/** Matches one run of Unicode letters or digits. */
const NAME_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

/**
 * The lowercased words of `text`. Composed first, so a name macOS stored as
 * a letter plus a combining mark ("a" + "¨") reads the same as a typed "ä".
 */
function nameTokens(text: string): string[] {
  return text.normalize("NFC").toLowerCase().match(NAME_TOKEN_PATTERN) ?? [];
}

function startsAnyToken(tokens: readonly string[], word: string): boolean {
  return tokens.some((token) => token.startsWith(word));
}

/**
 * Classifies how a file's name answers `query`, word by word:
 *
 * - `exact`: the name, with or without its extension, is the query.
 * - `words`: every query word starts a word of the name.
 * - `path`: every query word starts a word of the name or of a folder above
 *   it, and at least one is in the name.
 * - `none`: anything else, including a query with no words.
 *
 * Words match from their start ("plan" matches "planning", not "airplane"),
 * ignoring case, punctuation and how accents are encoded. Below `exact`,
 * one-letter query words are skipped unless the query has no others.
 */
export function nameMatch(query: string, target: NameMatchTarget): NameMatch {
  const queryTokens = nameTokens(query);
  if (queryTokens.length === 0) {
    return "none";
  }
  const full = nameTokens(target.name);
  const dot = target.name.lastIndexOf(".");
  const stem = dot > 0 ? nameTokens(target.name.slice(0, dot)) : full;
  const wanted = queryTokens.join(" ");
  if (wanted === stem.join(" ") || wanted === full.join(" ")) {
    return "exact";
  }

  // A lone letter ("plan b", "i") starts too many words to tell files apart.
  const longer = queryTokens.filter((word) => word.length > 1);
  const words = longer.length > 0 ? longer : queryTokens;
  const inName = words.filter((word) => startsAnyToken(full, word));
  if (inName.length === words.length) {
    return "words";
  }
  if (inName.length === 0) {
    return "none";
  }
  const folders = nameTokens(target.folder);
  return words.every((word) => startsAnyToken(full, word) || startsAnyToken(folders, word))
    ? "path"
    : "none";
}

/** Days after which a file has lost half of the score recency can add. */
export const RECENCY_HALF_LIFE_DAYS = 180;
/** The share of its score a file keeps however old it is. */
export const RECENCY_FLOOR = 0.4;

const MS_PER_DAY = 86_400_000;

/**
 * The factor a result's score is multiplied by for its age: `1` for a file
 * modified now, falling by half of what is left above `RECENCY_FLOOR` every
 * `RECENCY_HALF_LIFE_DAYS`. The floor keeps an old file findable: it needs
 * a clearly better match to outrank a recent one, not an impossible one. A
 * modification time in the future counts as now.
 */
export function recencyWeight(modifiedAt: Date, now: Date): number {
  const ageDays = Math.max(0, now.getTime() - modifiedAt.getTime()) / MS_PER_DAY;
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}
