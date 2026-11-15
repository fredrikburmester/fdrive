import { isReservedPath, normalizePath, parseSearchFilters, toFsPath } from "@fdrive/core";
import type {
  DuplicateGroup,
  FileFilter,
  FileOrder,
  IdentityRepo,
  IndexedFile,
  IndexQueries,
} from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import { relocatePath } from "../fs/mutations.js";
import type { MetadataService } from "../metadata/service.ts";
import { createReadAuthorizer, type ReadAuthorizer } from "../scoping/read-authorizer.ts";
import type { ScopeResolver } from "../scoping/resolver.ts";
import type { UnavailableReason } from "../scoping/types.ts";
import type { ImageSearchService } from "../search/image-service.ts";
import { toIndexRelativePath } from "../search/scopes.js";
import type { SearchService } from "../search/service.js";
import type { TokenPrincipal } from "../tokens/principal.ts";
import {
  assertMutablePath,
  canBrowsePath,
  canOrganize,
  canReadPath,
  ordinaryPath,
  RESERVED_MESSAGE,
  requireMode,
  tokenScopes,
} from "./access.ts";
import { isoFromNs, normalizeExtArg, nsFromIso, overviewFolderKey, pathDepth } from "./format.js";
import type { IndexerExtractClient } from "./indexer-client.js";
import {
  narrowScopePrefixes,
  reservedExclusionOf,
  resolveScopeContext,
  type ScopeContext,
  virtualPathFor,
} from "./scope-context.js";
import { fileUrl, folderUrl } from "./urls.js";

/**
 * Every index-backed tool authorizes at most this many candidate files per
 * request, at the `ReadAuthorizer`'s default concurrency (6). Whenever this
 * cap, a denial, or an unavailable probe reduces what a tool actually
 * examined below what the index reported, the response carries
 * `partial: true` rather than presenting a bounded, filtered count as an
 * exhaustive one. See `docs/SCOPING.md`.
 */
export const MAX_CANDIDATE_FILES = 2000;

/** Dependencies every MCP tool handler needs, resolved once per fdrive process and shared across requests. */
export interface McpToolDeps {
  /** Records explicit tool commands. Absent in deployments without history. */
  readonly activity?: import("../activity/service.js").PersonalActivityService;
  readonly activityReads?: import("@fdrive/db").ActivityReadsRepo;
  /** Hashed credential, so one token's repeated reads aggregate together. */
  readonly activityContext?: string;
  readonly activityRequestId?: string;
  readonly indexQueries: IndexQueries;
  readonly searchService: SearchService;
  readonly imageSearchService?: ImageSearchService;
  readonly metadata?: MetadataService;
  /**
   * Resolves each caller's *verified* index scopes, the only source of
   * index-backed authorization every tool in this file uses; there is no
   * username/template fallback. See `docs/SCOPING.md`.
   */
  readonly scopeResolver: Pick<ScopeResolver, "verifiedIndexScopes">;
  readonly identities: Pick<IdentityRepo, "get">;
  /**
   * The address everyone opens fdrive at (System > Features), the base of
   * every link a tool returns; `null` until the owner sets one, when links
   * are relative paths (still useful to an LLM, just not clickable).
   */
  readonly publicUrl: () => Promise<string | null>;
  /** Document text extraction for `read_file_text`; `null` without `FDRIVE_INDEXER_URL`. */
  readonly indexerClient: IndexerExtractClient | null;
  readonly clock: () => Date;
  /**
   * The storage provider's recycle folder virtual path, when configured.
   * Threaded into every `resolveScopeContext` call so `virtualPathFor`
   * excludes trashed files from every tool's results.
   */
  readonly trashPath?: string | null;
  readonly trashPathForStorage?: (storage: Principal["storage"]) => string | null;
  readonly onMutation?: (
    principal: Principal,
    change: {
      kind: "move" | "copy" | "create" | "mkdir" | "trash" | "restore";
      path: string;
      target?: string;
      eventPath?: string;
      moveMetadata?: boolean;
      /** Where a trashed item went in Trash, when the storage reported it. */
      trashLeaf?: string;
      isDir: boolean;
    },
  ) => Promise<void>;
}

/** Thrown by a handler when a business rule fails; `tools.ts` maps this (and any other error) to an MCP tool error. */
export class McpToolError extends Error {}

/** A resolved, verified scope plus the one bounded live-read authorizer built for this tool call. */
interface ScopedRequest {
  readonly ctx: ScopeContext;
  readonly authorizer: ReadAuthorizer;
}

/** A short, reason-carrying message that never leaks anything about individual paths, only the caller's own scope status. */
function indexUnavailableMessage(reason: UnavailableReason): string {
  return `index features are unavailable for this identity (${reason})`;
}

/**
 * Resolves the caller's verified index scopes and builds one bounded,
 * request-local `ReadAuthorizer` bound to their own storage. Throws a
 * friendly, reason-safe `McpToolError` when index-backed tools are
 * unavailable for them, rather than ever falling back to a username/template
 * mapping. Kept separate from the `*InScope` functions below (which take an
 * already-resolved `ScopeContext` and `ReadAuthorizer` as plain arguments)
 * so those can be unit tested without a real `IndexQueries` or `Principal`.
 */
async function requireScope(deps: McpToolDeps, principal: Principal): Promise<ScopedRequest> {
  const identity = await deps.identities.get(principal.identityId);
  const verified =
    identity === null
      ? ({ available: false, reason: "no_connection" } as const)
      : await deps.scopeResolver.verifiedIndexScopes(identity);
  if (!verified.available) {
    throw new McpToolError(indexUnavailableMessage(verified.reason));
  }

  const trashPath = currentTrashPath(deps, principal);
  const ctx = await resolveScopeContext(
    deps.indexQueries,
    tokenScopes(principal, verified.scopes),
    trashPath,
  );
  if (ctx === null) {
    throw new McpToolError(indexUnavailableMessage("no_roots"));
  }

  return { ctx, authorizer: createReadAuthorizer({ storage: principal.storage }) };
}

type TrashPathDeps = Pick<McpToolDeps, "trashPath" | "trashPathForStorage">;

function currentTrashPath(deps: TrashPathDeps, principal: Principal): string | null {
  return deps.trashPathForStorage?.(principal.storage) ?? deps.trashPath ?? null;
}

/** The common shape every MCP tool returns for one file, before tool-specific extra fields are added. */
export interface FileSummary {
  readonly path: string;
  readonly url: string;
  readonly name: string;
  readonly ext: string;
  readonly size_bytes: number;
  readonly modified: string;
  readonly sha256: string | null;
  readonly text_status: string;
  readonly text_chars: number;
}

/** Builds a `FileSummary` from a file and its already round-tripped, already read-authorized virtual path. */
function fileSummaryFor(
  publicUrl: string | null,
  file: IndexedFile,
  virtualPath: string,
): FileSummary {
  return {
    path: virtualPath,
    url: fileUrl(publicUrl, virtualPath),
    name: file.name,
    ext: file.ext,
    size_bytes: file.size,
    modified: isoFromNs(file.mtimeNs),
    sha256: file.sha256,
    text_status: file.textStatus,
    text_chars: file.textChars,
  };
}

/** The outcome of authorizing a bounded batch of `IndexedFile` candidates: only the accessible ones, plus their virtual paths and whether anything was left out. */
export interface AuthorizedFiles {
  readonly files: readonly IndexedFile[];
  readonly virtualPaths: ReadonlyMap<number, string>;
  readonly partial: boolean;
}

/**
 * Filters `candidates` (already restricted to `ctx`'s scope by the caller's
 * `IndexQueries` predicate) down to the subset that both round-trips
 * (`virtualPathFor`) and passes a live read check, preserving `candidates`'
 * original order. Never examines more than `MAX_CANDIDATE_FILES`.
 * `partial` is `true` whenever the cap was hit or any candidate was dropped
 * (shadowed, denied, or an unavailable probe), so a caller can report that
 * truthfully rather than presenting the accessible subset as exhaustive.
 */
export async function authorizeIndexedFiles(
  ctx: ScopeContext,
  authorizer: ReadAuthorizer,
  candidates: readonly IndexedFile[],
): Promise<AuthorizedFiles> {
  const capped = candidates.slice(0, MAX_CANDIDATE_FILES);
  let partial = candidates.length > capped.length;

  const resolved = await Promise.all(
    capped.map(async (file): Promise<{ file: IndexedFile; virtualPath: string } | null> => {
      const virtualPath = virtualPathFor(ctx, file.rootId, file.path);
      if (virtualPath === null) {
        return null;
      }
      const authResult = await authorizer.authorize({ path: virtualPath, kind: "file" });
      return authResult.allowed ? { file, virtualPath } : null;
    }),
  );

  const virtualPaths = new Map<number, string>();
  const files: IndexedFile[] = [];
  for (const entry of resolved) {
    if (entry === null) {
      partial = true;
      continue;
    }
    virtualPaths.set(entry.file.id, entry.virtualPath);
    files.push(entry.file);
  }

  return { files, virtualPaths, partial };
}

// ---------------------------------------------------------------- search

export interface SearchArgs {
  readonly query: string;
  readonly path_prefix?: string | undefined;
  readonly ext?: string | undefined;
  readonly modified_after?: string | undefined;
  readonly modified_before?: string | undefined;
  readonly limit?: number | undefined;
}

export async function runSearch(deps: McpToolDeps, principal: Principal, args: SearchArgs) {
  const filters = parseSearchFilters({
    folder: args.path_prefix,
    ext: args.ext,
    after: args.modified_after,
    before: args.modified_before,
  });
  const identity = await deps.identities.get(principal.identityId);
  const verified =
    identity === null
      ? { available: false as const }
      : await deps.scopeResolver.verifiedIndexScopes(identity);
  const response = await deps.searchService.search({
    trashPath: currentTrashPath(deps, principal),
    scopes: verified.available ? tokenScopes(principal, verified.scopes) : [],
    authorizer: createReadAuthorizer({ storage: principal.storage }),
    query: args.query,
    filters,
    limit: Math.max(1, Math.min(args.limit ?? 10, 50)),
  });

  if (response.unavailable) {
    return { query: args.query, results: [], available: false, unavailable: true };
  }

  const publicUrl = await deps.publicUrl();
  const results = response.sections.files.map((hit) => ({
    path: hit.path,
    url: fileUrl(publicUrl, hit.path),
    name: hit.name,
    ext: hit.ext,
    size_bytes: hit.size,
    modified: hit.modifiedAt,
    score: hit.score,
    snippets: hit.snippets.map((snippet) => snippet.text),
  }));

  return {
    query: args.query,
    results,
    ...(response.degraded ? { degraded: true } : {}),
    ...(response.partial ? { partial: true } : {}),
  };
}

// ------------------------------------------------------------- find_files

export interface FindFilesArgs {
  readonly name_contains?: string | undefined;
  readonly path_prefix?: string | undefined;
  readonly ext?: string | undefined;
  readonly modified_after?: string | undefined;
  readonly modified_before?: string | undefined;
  readonly min_size_mb?: number | undefined;
  readonly order_by?: FileOrder | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

/**
 * `find_files`'s logic given an already-resolved scope and authorizer.
 * Exported so tests can exercise every branch with a hand-built
 * `ScopeContext`. `total_matches` is the count of files this call actually
 * verified are readable, never the underlying SQL query's unfiltered total;
 * `partial` is set whenever that undercounts what might really be there.
 */
export async function findFilesInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
  authorizer: ReadAuthorizer,
  args: FindFilesArgs,
) {
  const prefixes = narrowScopePrefixes(ctx, args.path_prefix);
  if (prefixes === null) {
    throw new McpToolError("path_prefix is outside this identity's scope");
  }

  const ext = normalizeExtArg(args.ext);
  const modifiedAfterNs = nsFromIso(args.modified_after);
  const modifiedBeforeNs = nsFromIso(args.modified_before);
  const filter: FileFilter = {
    exclude: reservedExclusionOf(ctx),
    ...(args.name_contains !== undefined ? { nameContains: args.name_contains } : {}),
    ...(ext !== undefined ? { ext } : {}),
    ...(modifiedAfterNs !== undefined ? { modifiedAfterNs } : {}),
    ...(modifiedBeforeNs !== undefined ? { modifiedBeforeNs } : {}),
    ...(args.min_size_mb !== undefined
      ? { minSize: Math.round(args.min_size_mb * 1024 * 1024) }
      : {}),
  };
  const limit = Math.max(1, Math.min(args.limit ?? 50, 500));

  const { total, files: candidates } = await deps.indexQueries.listFiles(
    prefixes,
    filter,
    args.order_by ?? "modified_desc",
    Math.min(limit, MAX_CANDIDATE_FILES),
    ...(args.offset === undefined ? [] : [args.offset]),
  );

  const {
    files: accessible,
    virtualPaths,
    partial: authPartial,
  } = await authorizeIndexedFiles(ctx, authorizer, candidates);

  const publicUrl = await deps.publicUrl();
  const results = accessible.map((file) => {
    const virtualPath = virtualPaths.get(file.id);
    // Every entry of `accessible` has a matching `virtualPaths` entry by
    // construction (`authorizeIndexedFiles` sets both together); the
    // fallback below only guards the type checker.
    return fileSummaryFor(publicUrl, file, virtualPath ?? "");
  });
  const nextOffset = (args.offset ?? 0) + candidates.length;
  const partial = authPartial || total > nextOffset;

  return {
    ...(total > nextOffset ? { next_offset: nextOffset } : {}),
    total_matches: accessible.length,
    results,
    ...(partial ? { partial: true } : {}),
  };
}

export async function runFindFiles(deps: McpToolDeps, principal: Principal, args: FindFilesArgs) {
  const { ctx, authorizer } = await requireScope(deps, principal);
  return findFilesInScope(deps, ctx, authorizer, args);
}

// --------------------------------------------------------- list_directory

export interface ListDirectoryArgs {
  readonly path?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * Lists a folder directly through `principal.storage`, authorized by the
 * storage itself (the login's own and shared folders), independent of index
 * availability: this tool never consults `ScopeResolver` or `IndexQueries`.
 * fdrive's own folders (`isReservedPath`: the Trash, the Mac app's folder
 * and the rest) are withheld from ordinary browsing; direct requests into
 * one fail before storage is touched, and their entries are removed before
 * pagination. The listing is taken at the normalized path that check ran
 * against, never the raw argument, so the folder read is always the one
 * that was checked.
 */
export async function runListDirectory(
  deps: TrashPathDeps & Partial<Pick<McpToolDeps, "publicUrl">>,
  principal: TokenPrincipal,
  args: ListDirectoryArgs,
) {
  const path = normalizePath(args.path ?? "/");
  if (!canBrowsePath(principal, path))
    throw new McpToolError("path is outside this token's allowed folders");
  const trashPath = currentTrashPath(deps, principal);
  if (isReservedPath(path, trashPath)) {
    throw new McpToolError(RESERVED_MESSAGE);
  }

  const limit = Math.max(1, Math.min(args.limit ?? 300, 2000));
  const entries = await principal.storage.list(path);
  const ordinary = entries.filter((entry) => !isReservedPath(entry.path, trashPath));
  const visible = ordinary.filter((entry) =>
    entry.kind === "dir"
      ? canBrowsePath(principal, entry.path)
      : canReadPath(principal, entry.path),
  );
  visible.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const offset = args.offset ?? 0;
  const truncated = visible.length > offset + limit;
  const sliced = visible.slice(offset, offset + limit);
  const publicUrl = (await deps.publicUrl?.()) ?? null;

  return {
    path,
    url: folderUrl(publicUrl, path),
    entries: sliced.map((entry) => ({
      name: entry.name,
      type: entry.kind === "dir" ? "dir" : "file",
      path: entry.path,
      size_bytes: entry.kind === "dir" ? null : entry.size,
      modified: canReadPath(principal, entry.path) ? entry.modifiedAt.toISOString() : null,
      url: entry.kind === "dir" ? folderUrl(publicUrl, entry.path) : fileUrl(publicUrl, entry.path),
    })),
    truncated,
    ...(truncated ? { next_offset: offset + sliced.length } : {}),
  };
}

// -------------------------------------------------------------- file_info

export interface FileInfoArgs {
  readonly path: string;
}

/** `file_info`'s logic given an already-resolved scope and authorizer. Exported so tests can exercise every branch with a hand-built `ScopeContext`. */
export async function fileInfoInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
  authorizer: ReadAuthorizer,
  args: FileInfoArgs,
) {
  const resolved = toFsPath(ctx.scopes, args.path);
  if (resolved === null) {
    throw new McpToolError("path is outside this identity's scope");
  }
  const rootId = ctx.rootIdByName.get(resolved.rootName);
  if (rootId === undefined) {
    throw new McpToolError("that root is not indexed yet");
  }

  const file = await deps.indexQueries.fileByPath(rootId, toIndexRelativePath(resolved.fsPath));
  if (file === null) {
    throw new McpToolError(`file is not indexed yet: ${args.path}`);
  }

  const virtualPath = virtualPathFor(ctx, file.rootId, file.path);
  if (virtualPath === null) {
    throw new McpToolError(`file is not indexed yet: ${args.path}`);
  }

  // A read-denied file is reported exactly like an unindexed one: revealing
  // that it exists but cannot be read would itself leak information a
  // wrong or narrower mapping should never disclose.
  const authResult = await authorizer.authorize({ path: virtualPath, kind: "file" });
  if (!authResult.allowed) {
    throw new McpToolError(`file is not indexed yet: ${args.path}`);
  }

  const summary = fileSummaryFor(await deps.publicUrl(), file, virtualPath);

  let identicalCopies: string[] = [];
  let partial = false;
  if (file.sha256 !== null) {
    const copies = await deps.indexQueries.filesBySha256(ctx.scopePrefixes, file.sha256, file.id, {
      exclude: reservedExclusionOf(ctx),
    });
    const authorizedCopies = await authorizeIndexedFiles(ctx, authorizer, copies);
    identicalCopies = authorizedCopies.files
      .map((copy) => authorizedCopies.virtualPaths.get(copy.id))
      .filter((path): path is string => path !== undefined);
    partial = authorizedCopies.partial;
  }

  return {
    ...summary,
    mime: file.mime,
    error: file.error,
    indexed_at: file.indexedAt?.toISOString() ?? null,
    identical_copies: identicalCopies,
    ...(partial ? { partial: true } : {}),
  };
}

// -------------------------------------------------------- find_duplicates

export interface FindDuplicatesArgs {
  readonly path_prefix?: string | undefined;
  readonly min_size_mb?: number | undefined;
  readonly limit?: number | undefined;
}

interface MappedDuplicateGroup {
  readonly sha256: string;
  readonly size_bytes: number;
  readonly copies: number;
  readonly wasted_bytes: number;
  readonly paths: readonly string[];
}

/**
 * Filters raw `DuplicateGroup` rows down to only authorized copies (round
 * trip plus a live read check on every location, capped in total at
 * `MAX_CANDIDATE_FILES` across every group combined), dropping any group
 * left with fewer than two authorized copies. Counts and wasted bytes are
 * computed only from what survives.
 */
export async function authorizeDuplicateGroups(
  ctx: ScopeContext,
  authorizer: ReadAuthorizer,
  groups: readonly DuplicateGroup[],
): Promise<{ groups: MappedDuplicateGroup[]; partial: boolean }> {
  const flat = groups.flatMap((group, groupIndex) =>
    group.files.map((location) => ({ groupIndex, location })),
  );
  const capped = flat.slice(0, MAX_CANDIDATE_FILES);
  let partial = flat.length > capped.length;

  const resolved = await Promise.all(
    capped.map(async (entry): Promise<{ groupIndex: number; virtualPath: string } | null> => {
      const virtualPath = virtualPathFor(ctx, entry.location.rootId, entry.location.path);
      if (virtualPath === null) {
        return null;
      }
      const authResult = await authorizer.authorize({ path: virtualPath, kind: "file" });
      return authResult.allowed ? { groupIndex: entry.groupIndex, virtualPath } : null;
    }),
  );

  const pathsByGroup = new Map<number, string[]>();
  for (const entry of resolved) {
    if (entry === null) {
      partial = true;
      continue;
    }
    const list = pathsByGroup.get(entry.groupIndex) ?? [];
    list.push(entry.virtualPath);
    pathsByGroup.set(entry.groupIndex, list);
  }

  const mappedGroups: MappedDuplicateGroup[] = [];
  groups.forEach((group, index) => {
    const paths = pathsByGroup.get(index) ?? [];
    if (paths.length < 2) {
      return;
    }
    mappedGroups.push({
      sha256: group.sha256,
      size_bytes: group.size,
      copies: paths.length,
      wasted_bytes: group.size * (paths.length - 1),
      paths,
    });
  });

  return { groups: mappedGroups, partial };
}

/** `find_duplicates`'s logic given an already-resolved scope and authorizer. Exported so tests can exercise every branch with a hand-built `ScopeContext`. */
export async function findDuplicatesInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
  authorizer: ReadAuthorizer,
  args: FindDuplicatesArgs,
) {
  const prefixes = narrowScopePrefixes(ctx, args.path_prefix);
  if (prefixes === null) {
    throw new McpToolError("path_prefix is outside this identity's scope");
  }

  const minSize = Math.round((args.min_size_mb ?? 1) * 1024 * 1024);
  const groups = await deps.indexQueries.duplicates(
    prefixes,
    minSize,
    Math.max(1, Math.min(args.limit ?? 40, 200)),
    { exclude: reservedExclusionOf(ctx) },
  );

  const { groups: mappedGroups, partial } = await authorizeDuplicateGroups(ctx, authorizer, groups);
  const totalWasted = mappedGroups.reduce((sum, group) => sum + group.wasted_bytes, 0);

  return {
    total_groups: mappedGroups.length,
    total_wasted_bytes: totalWasted,
    groups: mappedGroups,
    ...(partial ? { partial: true } : {}),
  };
}

export async function runFindDuplicates(
  deps: McpToolDeps,
  principal: Principal,
  args: FindDuplicatesArgs,
) {
  const { ctx, authorizer } = await requireScope(deps, principal);
  return findDuplicatesInScope(deps, ctx, authorizer, args);
}

// ---------------------------------------------------------- similar_files

export interface SimilarFilesArgs {
  readonly path: string;
  readonly limit?: number | undefined;
}

type SimilarResult = FileSummary & { similarity: number };

/**
 * `similar_files`'s logic given an already-resolved scope and authorizer.
 * Exported so tests can exercise every branch with a hand-built
 * `ScopeContext`. The source file itself must round-trip and pass a live
 * read check too, not only the candidates it is compared against.
 */
export async function similarFilesInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
  authorizer: ReadAuthorizer,
  args: SimilarFilesArgs,
) {
  const resolved = toFsPath(ctx.scopes, args.path);
  if (resolved === null) {
    throw new McpToolError("path is outside this identity's scope");
  }
  const rootId = ctx.rootIdByName.get(resolved.rootName);
  if (rootId === undefined) {
    throw new McpToolError("that root is not indexed yet");
  }

  const file = await deps.indexQueries.fileByPath(rootId, toIndexRelativePath(resolved.fsPath));
  if (file === null) {
    throw new McpToolError("file is not indexed");
  }

  const sourceVirtualPath = virtualPathFor(ctx, file.rootId, file.path);
  if (sourceVirtualPath === null) {
    throw new McpToolError("file is not indexed");
  }
  const sourceAuth = await authorizer.authorize({ path: sourceVirtualPath, kind: "file" });
  if (!sourceAuth.allowed) {
    throw new McpToolError("file is not indexed");
  }

  const similar = await deps.indexQueries.similar(
    file.id,
    ctx.scopePrefixes,
    Math.max(1, Math.min(args.limit ?? 10, 50)),
    { exclude: reservedExclusionOf(ctx) },
  );
  if (similar.length === 0) {
    return { path: args.path, results: [] };
  }

  const similarityById = new Map(similar.map((row) => [row.fileId, row.similarity]));
  const loadedById = new Map(
    (await deps.indexQueries.filesByIds(similar.map((row) => row.fileId))).map((row) => [
      row.id,
      row,
    ]),
  );
  // Preserves `similar`'s own ranked order (best similarity first), not
  // `filesByIds`' unordered response.
  const candidates = similar
    .map((row) => loadedById.get(row.fileId))
    .filter((candidate): candidate is IndexedFile => candidate !== undefined);

  const {
    files: accessible,
    virtualPaths,
    partial,
  } = await authorizeIndexedFiles(ctx, authorizer, candidates);

  const publicUrl = await deps.publicUrl();
  const results = accessible
    .map((matchedFile): SimilarResult | null => {
      const virtualPath = virtualPaths.get(matchedFile.id);
      const similarity = similarityById.get(matchedFile.id);
      if (virtualPath === undefined || similarity === undefined) {
        return null;
      }
      return {
        ...fileSummaryFor(publicUrl, matchedFile, virtualPath),
        similarity: Math.round(similarity * 10_000) / 10_000,
      };
    })
    .filter((entry): entry is SimilarResult => entry !== null);

  return { path: args.path, results, ...(partial ? { partial: true } : {}) };
}

export async function runSimilarFiles(
  deps: McpToolDeps,
  principal: Principal,
  args: SimilarFilesArgs,
) {
  const { ctx, authorizer } = await requireScope(deps, principal);
  return similarFilesInScope(deps, ctx, authorizer, args);
}

// -------------------------------------------------------- folder_overview

export interface FolderOverviewArgs {
  readonly path_prefix?: string | undefined;
  readonly depth?: number | undefined;
}

/**
 * `folder_overview`'s logic given an already-resolved scope and authorizer.
 * Exported so tests can exercise every branch with a hand-built
 * `ScopeContext`. Bytes and folder aggregates are only ever added for files
 * that passed both the round trip and a live read check; `truncated`
 * reflects both the underlying SQL cap and anything the authorization step
 * left out.
 */
export async function folderOverviewInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
  authorizer: ReadAuthorizer,
  args: FolderOverviewArgs,
) {
  const prefixes = narrowScopePrefixes(ctx, args.path_prefix);
  if (prefixes === null) {
    throw new McpToolError("path_prefix is outside this identity's scope");
  }

  const depth = Math.max(1, Math.min(args.depth ?? 1, 4));
  const prefixDepth = pathDepth(args.path_prefix ?? "/");
  const { total, files: candidates } = await deps.indexQueries.listFiles(
    prefixes,
    { exclude: reservedExclusionOf(ctx) },
    "path",
    MAX_CANDIDATE_FILES,
  );

  const {
    files: accessible,
    virtualPaths,
    partial: authPartial,
  } = await authorizeIndexedFiles(ctx, authorizer, candidates);

  interface Agg {
    files: number;
    bytes: number;
    newestNs: bigint;
    exts: Map<string, number>;
  }
  const byFolder = new Map<string, Agg>();

  let totalBytes = 0;
  for (const file of accessible) {
    const virtualPath = virtualPaths.get(file.id);
    if (virtualPath === undefined) {
      continue;
    }
    totalBytes += file.size;
    const key = overviewFolderKey(prefixDepth, depth, virtualPath);
    const agg = byFolder.get(key) ?? { files: 0, bytes: 0, newestNs: 0n, exts: new Map() };
    agg.files += 1;
    agg.bytes += file.size;
    if (file.mtimeNs > agg.newestNs) {
      agg.newestNs = file.mtimeNs;
    }
    const extKey = file.ext.length > 0 ? file.ext : "(none)";
    agg.exts.set(extKey, (agg.exts.get(extKey) ?? 0) + 1);
    byFolder.set(key, agg);
  }

  const publicUrl = await deps.publicUrl();
  const folders = Array.from(byFolder.entries())
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 200)
    .map(([path, agg]) => ({
      path,
      url: folderUrl(publicUrl, path),
      files: agg.files,
      bytes: agg.bytes,
      newest: agg.newestNs > 0n ? isoFromNs(agg.newestNs) : null,
      top_types: Array.from(agg.exts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([ext, count]) => ({ ext, count })),
    }));

  return {
    path_prefix: args.path_prefix ?? "/",
    depth,
    folders,
    total_files: accessible.length,
    total_bytes: totalBytes,
    truncated: authPartial || total > candidates.length,
  };
}

export async function runFolderOverview(
  deps: McpToolDeps,
  principal: Principal,
  args: FolderOverviewArgs,
) {
  const { ctx, authorizer } = await requireScope(deps, principal);
  return folderOverviewInScope(deps, ctx, authorizer, args);
}

// ------------------------------------------------------------ index_stats

/**
 * `index_stats`'s logic given an already-resolved scope and authorizer.
 * File and chunk counts are derived only from candidates that round-tripped
 * and passed a live read check (bounded at `MAX_CANDIDATE_FILES`), never
 * from the raw scope-wide SQL aggregate `IndexQueries.stats` computes for
 * the (unscoped, admin-only) System page.
 */
export async function indexStatsInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
  authorizer: ReadAuthorizer,
) {
  const { total, files: candidates } = await deps.indexQueries.listFiles(
    ctx.scopePrefixes,
    { exclude: reservedExclusionOf(ctx) },
    "path",
    MAX_CANDIDATE_FILES,
  );
  const { files: accessible, partial: authPartial } = await authorizeIndexedFiles(
    ctx,
    authorizer,
    candidates,
  );

  const byStatus = new Map<string, { files: number; bytes: number }>();
  for (const file of accessible) {
    const agg = byStatus.get(file.textStatus) ?? { files: 0, bytes: 0 };
    agg.files += 1;
    agg.bytes += file.size;
    byStatus.set(file.textStatus, agg);
  }

  const chunkStats = await deps.indexQueries.statsForFileIds(accessible.map((file) => file.id));
  const partial = authPartial || total > candidates.length;

  return {
    files_tracked: accessible.length,
    by_text_status: Array.from(byStatus.entries()).map(([status, agg]) => ({
      status,
      files: agg.files,
      bytes: agg.bytes,
    })),
    chunks: chunkStats.chunks,
    chunks_embedded: chunkStats.chunksEmbedded,
    ...(partial ? { partial: true } : {}),
  };
}

/** `index_stats` for a token: the index counts plus whether it may organize (`writes_enabled`). */
export async function runIndexStats(deps: McpToolDeps, principal: TokenPrincipal) {
  const { ctx, authorizer } = await requireScope(deps, principal);
  const stats = await indexStatsInScope(deps, ctx, authorizer);
  return { ...stats, writes_enabled: canOrganize(principal) };
}

// ----------------------------------------------------------- create_folder

export interface CreateFolderArgs {
  readonly path: string;
}

/**
 * Creates a folder through `principal.storage` inside the token's folders
 * and outside fdrive's own (`ordinaryPath`). The folder is created at the
 * admitted, normalized path, not at the raw argument, so the location
 * written is always the one that was checked. Works without any index.
 */
export async function runCreateFolder(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  args: CreateFolderArgs,
) {
  requireMode(principal, "organize");
  const path = ordinaryPath(deps, principal, args.path);
  const publicUrl = await deps.publicUrl();
  await principal.storage.mkdir(path, { parents: true });
  let warnings: string[] = [];
  try {
    await deps.onMutation?.(principal, { kind: "mkdir", path, isDir: true });
  } catch {
    warnings = ["Folder created, but live updates could not be updated."];
  }
  return {
    created: path,
    url: folderUrl(publicUrl, path),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// -------------------------------------------------------------- move_path

export interface MovePathArgs {
  readonly src: string;
  readonly dst: string;
}

/**
 * Moves or renames a path through `principal.storage` once both `src` and
 * `dst` are inside the token's folders and outside fdrive's own
 * (`ordinaryPath`), and `src` is not a grant root or a folder holding Trash.
 * Both ends use the admitted paths, not the raw arguments. Personal activity
 * records the move through the request's storage, which is where
 * `recent_moves` reads it back.
 */
export async function runMovePath(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  args: MovePathArgs,
) {
  requireMode(principal, "organize");
  const trashPath = currentTrashPath(deps, principal);
  const src = ordinaryPath(deps, principal, args.src);
  const dst = ordinaryPath(deps, principal, args.dst);
  assertMutablePath(principal, src, trashPath);
  const isDir = (await principal.storage.stat(src)).kind === "dir";
  const publicUrl = await deps.publicUrl();
  await relocatePath(principal.storage, "move", src, dst);
  let warnings: string[] = [];
  if (src !== dst) {
    try {
      await deps.onMutation?.(principal, { kind: "move", path: src, target: dst, isDir });
    } catch {
      warnings = ["File moved, but metadata or live updates could not be updated."];
    }
  }
  return {
    moved: src,
    to: dst,
    url: isDir ? folderUrl(publicUrl, dst) : fileUrl(publicUrl, dst),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ----------------------------------------------------------- recent_moves

export interface RecentMovesArgs {
  readonly limit?: number | undefined;
}

/** Events `recent_moves` reads per page; personal activity lists at most this many at once. */
const ACTIVITY_PAGE = 100;

/** The most events `recent_moves` reads to fill one answer before it reports `partial`. */
export const MAX_RECENT_MOVE_EVENTS = 2000;

/**
 * The moves this token's login made through MCP, newest first, read from its
 * personal activity: successful `file.move` events from source `mcp`, of the
 * token's own account and login and no one else's. A move is listed only
 * when both its ends are inside this token's folders and outside fdrive's
 * own. Reads at most `MAX_RECENT_MOVE_EVENTS` events, and reports `partial`
 * when it stopped there short of `limit` with more left to read.
 */
export async function runRecentMoves(
  deps: McpToolDeps,
  principal: TokenPrincipal,
  args: RecentMovesArgs,
) {
  const limit = Math.max(1, Math.min(args.limit ?? 50, 500));
  const repo = deps.activity?.repo;
  if (repo === undefined) return { moves: [] };
  const trashPath = currentTrashPath(deps, principal);
  const listed = (path: string | undefined): path is string =>
    path !== undefined && canReadPath(principal, path) && !isReservedPath(path, trashPath);

  const moves: { at: string; src: string; dst: string }[] = [];
  let after: { at: Date; id: string } | undefined;
  for (let read = 0; read < MAX_RECENT_MOVE_EVENTS; ) {
    const page = await repo.list(principal.accountId, {
      identityId: principal.identityId,
      action: "file.move",
      source: "mcp",
      outcome: "success",
      limit: ACTIVITY_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    read += page.length;
    for (const event of page) {
      const src = event.before?.path;
      const dst = event.after?.path;
      if (!listed(src) || !listed(dst)) continue;
      moves.push({ at: (event.occurredAt ?? event.sortAt).toISOString(), src, dst });
      if (moves.length === limit) return { moves };
    }
    const last = page.at(-1);
    if (page.length < ACTIVITY_PAGE || last === undefined) return { moves };
    after = { at: last.sortAt, id: last.id };
  }
  return { moves, partial: true };
}
