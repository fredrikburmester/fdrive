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
