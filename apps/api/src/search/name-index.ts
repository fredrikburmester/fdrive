import type { IndexExclusion, ScopePrefix } from "@fdrive/db";
import { toIndexRelativePath } from "./scopes.js";

/** One file or folder row whose name answered a search, as the name index returns it. */
export interface NameIndexHit {
  /** The row's id in `idx.files` or `idx.folders`. */
  readonly id: number;
  readonly rootId: number;
  /** Root-relative, as the index stores it. */
  readonly path: string;
  readonly mtimeNs: bigint;
}

export interface NameIndexHits {
  readonly files: readonly NameIndexHit[];
  readonly folders: readonly NameIndexHit[];
}

export interface NameIndexSearch {
  readonly query: string;
  /** Where to look, already verified; the same prefixes the index queries get. */
  readonly scopes: readonly ScopePrefix[];
  /** What to leave out before the limits: fdrive's own folders (`reservedExclusion`). */
  readonly exclude: IndexExclusion;
  /** How many files and how many folders to return at most. */
  readonly files: number;
  readonly folders: number;
}

/**
 * The indexer's name index: files and folders whose name answers a query
 * with a typo or two in it (`POST /names/search`).
 */
export interface NameIndexClient {
  /**
   * `null` when the indexer cannot answer (unreachable, still building its
   * index, or a malformed reply), so search runs without typo matches.
   */
  search(input: NameIndexSearch): Promise<NameIndexHits | null>;
}

export interface CreateNameIndexClientDeps {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  /** How long a search may wait for the indexer; it answers in milliseconds. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

function hitsFrom(value: unknown): NameIndexHit[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const hits: NameIndexHit[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const { id, root_id: rootId, path, mtime_ns: mtime } = item as Record<string, unknown>;
    if (
      typeof id !== "number" ||
      typeof rootId !== "number" ||
      typeof path !== "string" ||
      typeof mtime !== "string" ||
      !/^-?\d+$/.test(mtime)
    ) {
      return null;
    }
    hits.push({ id, rootId, path, mtimeNs: BigInt(mtime) });
  }
  return hits;
}

const place = (prefix: ScopePrefix) => ({
  root_id: prefix.rootId,
  prefix: toIndexRelativePath(prefix.fsPrefix),
});

/** Builds a client for the indexer's internal `POST /names/search`. */
export function createNameIndexClient(deps: CreateNameIndexClientDeps): NameIndexClient {
  return {
    async search(input) {
      try {
        const response = await deps.fetch(`${deps.baseUrl}/names/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: input.query,
            scopes: input.scopes.map(place),
            exclude: input.exclude.prefixes.map(place),
            exclude_names: input.exclude.names,
            files: input.files,
            folders: input.folders,
          }),
          signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        const body: unknown = await response.json();
        if (typeof body !== "object" || body === null) {
          return null;
        }
        const files = hitsFrom((body as Record<string, unknown>).files);
        const folders = hitsFrom((body as Record<string, unknown>).folders);
        return files === null || folders === null ? null : { files, folders };
      } catch {
        return null;
      }
    },
  };
}
