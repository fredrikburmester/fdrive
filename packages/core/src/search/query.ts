const MAX_TSQUERY_TOKENS = 12;
const MAX_QUERY_WORDS = 8;
const MIN_TSQUERY_TOKEN_LENGTH = 2;
const MIN_WORD_LENGTH = 3;

/** Matches one run of Unicode letters, digits, or underscores. */
const WORD_PATTERN = /[\p{L}\p{N}_]+/gu;

/** Matches any character that is not a Unicode letter or digit. */
const NON_ALNUM_PATTERN = /[^\p{L}\p{N}]+/gu;

/**
 * Builds a Postgres `to_tsquery('simple', ...)` prefix expression from a
 * free-text query, matching filesai's `_prefix_tsquery`: the query is split
 * on whitespace, each token has every non-alphanumeric character stripped,
 * tokens shorter than two characters are dropped, at most the first twelve
 * survive, and each becomes a `<token>:*` prefix match joined with `|` (an
 * OR). Returns "" when no token survives, which callers should treat as "no
 * full-text query to run".
 */
export function toPrefixTsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.replaceAll(NON_ALNUM_PATTERN, ""))
    .filter((token) => token.length >= MIN_TSQUERY_TOKEN_LENGTH)
    .slice(0, MAX_TSQUERY_TOKENS);

  return tokens.map((token) => `${token}:*`).join("|");
}

/**
 * Extracts the "significant" words from a free-text query for the filename
 * scoring pass, matching filesai's `search`: lowercased runs of word
 * characters, at least three characters long, at most the first eight.
 */
export function queryWords(query: string): string[] {
  const matches = query.toLowerCase().match(WORD_PATTERN) ?? [];
  return matches.filter((word) => word.length >= MIN_WORD_LENGTH).slice(0, MAX_QUERY_WORDS);
}
