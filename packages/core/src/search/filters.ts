import { isWithin, normalizePath } from "../paths.ts";

/**
 * Parsed, typed search filters, as read from `GET /api/v1/search`'s `ext`,
 * `folder`, `after`, and `before` query parameters. Each field is `null`
 * when the caller did not restrict on it.
 */
export interface SearchFilters {
  /** Lowercase extensions with a leading dot (e.g. ".pdf"), any one of which matches. */
  readonly exts: readonly string[] | null;
  /** A normalized virtual path; matches results at or below it. */
  readonly folder: string | null;
  /** Matches results modified at or after this instant. */
  readonly after: Date | null;
  /** Matches results modified at or before this instant. */
  readonly before: Date | null;
}

/** The raw, string-valued query parameters `parseSearchFilters` accepts. */
export interface RawSearchFilterQuery {
  readonly ext?: string | undefined;
  readonly folder?: string | undefined;
  readonly after?: string | undefined;
  readonly before?: string | undefined;
}

/** Normalizes one extension to lowercase with a leading dot, "" stays "". */
function normalizeExt(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/** Parses an ISO-ish date string, `null` for an absent or unparsable value. */
function parseDate(value: string | undefined): Date | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parses raw query-string values into typed `SearchFilters`. `ext` accepts
 * a comma-separated list (so the web UI's type chips, e.g. "images", can
 * expand to several extensions in one call); each is normalized to
 * lowercase with a leading dot. `folder` is normalized as a virtual path.
 * Invalid or empty values become `null` rather than throwing, since a
 * search request with a bad filter should still search unfiltered rather
 * than fail outright.
 */
export function parseSearchFilters(query: RawSearchFilterQuery): SearchFilters {
  const exts =
    query.ext === undefined || query.ext.trim().length === 0
      ? null
      : query.ext
          .split(",")
          .map(normalizeExt)
          .filter((ext) => ext.length > 0);

  let folder: string | null = null;
  if (query.folder !== undefined && query.folder.trim().length > 0) {
    try {
      folder = normalizePath(query.folder);
    } catch {
      // Invalid path filters follow the same nullable contract as invalid dates.
    }
  }

  return {
    exts: exts !== null && exts.length > 0 ? exts : null,
    folder,
    after: parseDate(query.after),
    before: parseDate(query.before),
  };
}

/** The minimal shape `matchesSearchFilters` needs from a search hit or entry. */
export interface FilterableEntry {
  readonly path: string;
  readonly ext: string;
  readonly modifiedAt: Date;
}

/**
 * True when `entry` satisfies every filter set in `filters`. An unset
 * filter (`null`) always matches.
 */
export function matchesSearchFilters(entry: FilterableEntry, filters: SearchFilters): boolean {
  if (filters.exts !== null && !filters.exts.includes(entry.ext.toLowerCase())) {
    return false;
  }
  if (filters.folder !== null && !isWithin(filters.folder, entry.path)) {
    return false;
  }
  if (filters.after !== null && entry.modifiedAt.getTime() < filters.after.getTime()) {
    return false;
  }
  if (filters.before !== null && entry.modifiedAt.getTime() > filters.before.getTime()) {
    return false;
  }
  return true;
}
