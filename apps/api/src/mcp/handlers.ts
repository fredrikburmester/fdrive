import type { HomeTemplate, Scope } from "@fdrive/core";
import { baseName, extensionOf, parseSearchFilters, toFsPath } from "@fdrive/core";
import type { FileFilter, FileOrder, IndexedFile, IndexQueries } from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import { toIndexRelativePath, usableScopesFor } from "../search/scopes.js";
import type { SearchService } from "../search/service.js";
import {
  isoFromNs,
  normalizeExtArg,
  nsFromIso,
  overviewFolderKey,
  pageText,
  pathDepth,
} from "./format.js";
import type { IndexerExtractClient } from "./indexer-client.js";
import {
  narrowScopePrefixes,
  resolveScopeContext,
  type ScopeContext,
  virtualPathFor,
} from "./scope-context.js";
import { fileUrl, folderUrl } from "./urls.js";

/** Dependencies every MCP tool handler needs, resolved once per fdrive process and shared across requests. */
export interface McpToolDeps {
  readonly indexQueries: IndexQueries;
  readonly homeTemplate: HomeTemplate;
  readonly indexRootNames: ReadonlySet<string>;
  readonly searchService: SearchService;
  readonly fdrivePublicUrl: string | undefined;
  readonly indexerClient: IndexerExtractClient | null;
  readonly writesEnabled: boolean;
  readonly clock: () => Date;
}

/** Thrown by a handler when a business rule fails; `tools.ts` maps this (and any other error) to an MCP tool error. */
export class McpToolError extends Error {}

/**
 * Resolves the caller's `ScopeContext`, throwing a friendly `McpToolError`
 * when index-backed tools are unavailable for them. Kept separate from the
 * `*InScope` functions below (which take an already-resolved `ScopeContext`
 * as a plain argument) so those can be unit tested against a hand-built
 * scope without needing a real `IndexQueries`.
 */
async function requireScopeContext(deps: McpToolDeps, principal: Principal): Promise<ScopeContext> {
  const ctx = await resolveScopeContext(
    deps.indexQueries,
    deps.homeTemplate,
    deps.indexRootNames,
    principal.username,
  );
  if (ctx === null) {
    throw new McpToolError("the index is not available for this identity");
  }
  return ctx;
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

function fileSummary(
  ctx: ScopeContext,
  publicUrl: string | undefined,
  file: IndexedFile,
): FileSummary | null {
  const virtualPath = virtualPathFor(ctx, file.rootId, file.path);
  if (virtualPath === null) {
    return null;
  }
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
  const response = await deps.searchService.search({
    username: principal.username,
    query: args.query,
    filters,
    limit: Math.max(1, Math.min(args.limit ?? 10, 50)),
  });

  if (response.unavailable) {
    return { query: args.query, results: [], available: false };
  }

  const results = response.sections.files.map((hit) => ({
    path: hit.path,
    url: fileUrl(deps.fdrivePublicUrl, hit.path),
    name: hit.name,
    ext: hit.ext,
    size_bytes: hit.size,
    modified: hit.modifiedAt,
    score: hit.score,
    snippets: hit.snippets.map((snippet) => snippet.text),
  }));

  return { query: args.query, results };
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
  readonly limit?: number | undefined;
}

/** `find_files`'s logic given an already-resolved scope. Exported so tests can exercise every branch with a hand-built `ScopeContext`. */
export async function findFilesInScope(deps: McpToolDeps, ctx: ScopeContext, args: FindFilesArgs) {
  const prefixes = narrowScopePrefixes(ctx, args.path_prefix);
  if (prefixes === null) {
    throw new McpToolError("path_prefix is outside this identity's scope");
  }

  const ext = normalizeExtArg(args.ext);
  const modifiedAfterNs = nsFromIso(args.modified_after);
  const modifiedBeforeNs = nsFromIso(args.modified_before);
  const filter: FileFilter = {
    ...(args.name_contains !== undefined ? { nameContains: args.name_contains } : {}),
    ...(ext !== undefined ? { ext } : {}),
    ...(modifiedAfterNs !== undefined ? { modifiedAfterNs } : {}),
    ...(modifiedBeforeNs !== undefined ? { modifiedBeforeNs } : {}),
    ...(args.min_size_mb !== undefined
      ? { minSize: Math.round(args.min_size_mb * 1024 * 1024) }
      : {}),
  };

  const { total, files } = await deps.indexQueries.listFiles(
    prefixes,
    filter,
    args.order_by ?? "modified_desc",
    Math.max(1, Math.min(args.limit ?? 50, 500)),
  );

  const results = files
    .map((file) => fileSummary(ctx, deps.fdrivePublicUrl, file))
    .filter((entry): entry is FileSummary => entry !== null);

  return { total_matches: total, results };
}

export async function runFindFiles(deps: McpToolDeps, principal: Principal, args: FindFilesArgs) {
  const ctx = await requireScopeContext(deps, principal);
  return findFilesInScope(deps, ctx, args);
}

// --------------------------------------------------------- list_directory

export interface ListDirectoryArgs {
  readonly path?: string | undefined;
  readonly limit?: number | undefined;
}

export async function runListDirectory(principal: Principal, args: ListDirectoryArgs) {
  const path = args.path ?? "/";
  const limit = Math.max(1, Math.min(args.limit ?? 300, 2000));
  const entries = await principal.storage.list(path);
  const truncated = entries.length > limit;
  const sliced = entries.slice(0, limit);

  return {
    path,
    url: folderUrl(undefined, path),
    entries: sliced.map((entry) => ({
      name: entry.name,
      type: entry.kind === "dir" ? "dir" : "file",
      path: entry.path,
      size_bytes: entry.kind === "dir" ? null : entry.size,
      modified: entry.modifiedAt.toISOString(),
      url: entry.kind === "dir" ? folderUrl(undefined, entry.path) : fileUrl(undefined, entry.path),
    })),
    truncated,
  };
}

// -------------------------------------------------------- read_file_text

export interface ReadFileTextArgs {
  readonly path: string;
  readonly offset?: number | undefined;
  readonly max_chars?: number | undefined;
}

/** `read_file_text`'s logic given an already-resolved scope list. Exported so tests can exercise the out-of-scope branch with a hand-built scope. */
export async function readFileTextWithScopes(
  deps: McpToolDeps,
  scopes: readonly Scope[],
  args: ReadFileTextArgs,
) {
  if (deps.indexerClient === null) {
    throw new McpToolError(
      "live text extraction is not configured (FDRIVE_INDEXER_URL is not set)",
    );
  }

  const resolved = toFsPath(scopes, args.path);
  if (resolved === null) {
    throw new McpToolError("path is outside this identity's scope");
  }

  const extracted = await deps.indexerClient.extract({
    root: resolved.rootName,
    path: toIndexRelativePath(resolved.fsPath),
  });
  if (extracted === null) {
    throw new McpToolError("failed to extract text (indexer unreachable or unsupported file)");
  }

  if (extracted.text.length === 0) {
    return {
      path: args.path,
      url: fileUrl(deps.fdrivePublicUrl, args.path),
      status: extracted.status,
      text: "",
    };
  }

  const page = pageText(extracted.text, args.offset ?? 0, args.max_chars ?? 8000);
  return {
    path: args.path,
    url: fileUrl(deps.fdrivePublicUrl, args.path),
    status: extracted.status,
    total_chars: page.totalChars,
    offset: args.offset ?? 0,
    text: page.slice,
    has_more: page.hasMore,
  };
}

export async function runReadFileText(
  deps: McpToolDeps,
  principal: Principal,
  args: ReadFileTextArgs,
) {
  const scopes = usableScopesFor(deps.homeTemplate, deps.indexRootNames, principal.username);
  return readFileTextWithScopes(deps, scopes, args);
}

// -------------------------------------------------------------- file_info

export interface FileInfoArgs {
  readonly path: string;
}

/** `file_info`'s logic given an already-resolved scope. Exported so tests can exercise every branch with a hand-built `ScopeContext`. */
export async function fileInfoInScope(deps: McpToolDeps, ctx: ScopeContext, args: FileInfoArgs) {
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

  const summary = fileSummary(ctx, deps.fdrivePublicUrl, file);
  if (summary === null) {
    throw new McpToolError(`file is not indexed yet: ${args.path}`);
  }

  const identicalCopies =
    file.sha256 !== null
      ? (await deps.indexQueries.filesBySha256(ctx.scopePrefixes, file.sha256, file.id))
          .map((copy) => virtualPathFor(ctx, copy.rootId, copy.path))
          .filter((copyPath): copyPath is string => copyPath !== null)
      : [];

  return {
    ...summary,
    mime: file.mime,
    error: file.error,
    indexed_at: file.indexedAt?.toISOString() ?? null,
    identical_copies: identicalCopies,
  };
}

export async function runFileInfo(deps: McpToolDeps, principal: Principal, args: FileInfoArgs) {
  const ctx = await requireScopeContext(deps, principal);
  return fileInfoInScope(deps, ctx, args);
}

// -------------------------------------------------------- find_duplicates

export interface FindDuplicatesArgs {
  readonly path_prefix?: string | undefined;
  readonly min_size_mb?: number | undefined;
  readonly limit?: number | undefined;
}

/** `find_duplicates`'s logic given an already-resolved scope. Exported so tests can exercise every branch with a hand-built `ScopeContext`. */
export async function findDuplicatesInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
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
  );

  const mappedGroups = groups.map((group) => {
    const paths = group.files
      .map((location) => virtualPathFor(ctx, location.rootId, location.path))
      .filter((path): path is string => path !== null);
    return {
      sha256: group.sha256,
      size_bytes: group.size,
      copies: group.count,
      wasted_bytes: group.size * (group.count - 1),
      paths,
    };
  });

  const totalWasted = mappedGroups.reduce((sum, group) => sum + group.wasted_bytes, 0);

  return {
    total_groups: mappedGroups.length,
    total_wasted_bytes: totalWasted,
    groups: mappedGroups,
  };
}

export async function runFindDuplicates(
  deps: McpToolDeps,
  principal: Principal,
  args: FindDuplicatesArgs,
) {
  const ctx = await requireScopeContext(deps, principal);
  return findDuplicatesInScope(deps, ctx, args);
}

// ---------------------------------------------------------- similar_files

export interface SimilarFilesArgs {
  readonly path: string;
  readonly limit?: number | undefined;
}

type SimilarResult = FileSummary & { similarity: number };

/** `similar_files`'s logic given an already-resolved scope. Exported so tests can exercise every branch with a hand-built `ScopeContext`. */
export async function similarFilesInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
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

  const similar = await deps.indexQueries.similar(
    file.id,
    ctx.scopePrefixes,
    Math.max(1, Math.min(args.limit ?? 10, 50)),
  );
  if (similar.length === 0) {
    return { path: args.path, results: [] };
  }

  const files = await deps.indexQueries.filesByIds(similar.map((row) => row.fileId));
  const fileById = new Map(files.map((row) => [row.id, row]));

  const results = similar
    .map((row): SimilarResult | null => {
      const matchedFile = fileById.get(row.fileId);
      if (matchedFile === undefined) {
        return null;
      }
      const summary = fileSummary(ctx, deps.fdrivePublicUrl, matchedFile);
      if (summary === null) {
        return null;
      }
      return { ...summary, similarity: Math.round(row.similarity * 10_000) / 10_000 };
    })
    .filter((entry): entry is SimilarResult => entry !== null);

  return { path: args.path, results };
}

export async function runSimilarFiles(
  deps: McpToolDeps,
  principal: Principal,
  args: SimilarFilesArgs,
) {
  const ctx = await requireScopeContext(deps, principal);
  return similarFilesInScope(deps, ctx, args);
}

// -------------------------------------------------------- folder_overview

export interface FolderOverviewArgs {
  readonly path_prefix?: string | undefined;
  readonly depth?: number | undefined;
}

/** Files considered per `folder_overview` call, a generous cap to avoid pulling an entire huge tree into memory. */
const OVERVIEW_FILE_CAP = 20_000;

/** `folder_overview`'s logic given an already-resolved scope. Exported so tests can exercise every branch with a hand-built `ScopeContext`. */
export async function folderOverviewInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
  args: FolderOverviewArgs,
) {
  const prefixes = narrowScopePrefixes(ctx, args.path_prefix);
  if (prefixes === null) {
    throw new McpToolError("path_prefix is outside this identity's scope");
  }

  const depth = Math.max(1, Math.min(args.depth ?? 1, 4));
  const prefixDepth = pathDepth(args.path_prefix ?? "/");
  const { files, total } = await deps.indexQueries.listFiles(
    prefixes,
    {},
    "path",
    OVERVIEW_FILE_CAP,
  );

  interface Agg {
    files: number;
    bytes: number;
    newestNs: bigint;
    exts: Map<string, number>;
  }
  const byFolder = new Map<string, Agg>();

  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    const virtualPath = virtualPathFor(ctx, file.rootId, file.path);
    if (virtualPath === null) {
      continue;
    }
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

  const folders = Array.from(byFolder.entries())
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 200)
    .map(([path, agg]) => ({
      path,
      url: folderUrl(deps.fdrivePublicUrl, path),
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
    total_files: files.length,
    total_bytes: totalBytes,
    truncated: total > files.length,
  };
}

export async function runFolderOverview(
  deps: McpToolDeps,
  principal: Principal,
  args: FolderOverviewArgs,
) {
  const ctx = await requireScopeContext(deps, principal);
  return folderOverviewInScope(deps, ctx, args);
}

// ------------------------------------------------------------ index_stats

export async function runIndexStats(deps: McpToolDeps, principal: Principal) {
  const ctx = await requireScopeContext(deps, principal);
  const stats = await deps.indexQueries.stats(ctx.scopePrefixes);
  return {
    files_tracked: stats.filesTracked,
    by_text_status: stats.byTextStatus.map((row) => ({
      status: row.status,
      files: row.files,
      bytes: row.bytes,
    })),
    chunks: stats.chunks,
    chunks_embedded: stats.chunksEmbedded,
    writes_enabled: deps.writesEnabled,
  };
}

// ----------------------------------------------------------- create_folder

export interface CreateFolderArgs {
  readonly path: string;
}

function requireWrites(deps: McpToolDeps): void {
  if (!deps.writesEnabled) {
    throw new McpToolError("write tools are disabled (FDRIVE_MCP_WRITES=false)");
  }
}

export async function runCreateFolder(
  deps: McpToolDeps,
  principal: Principal,
  args: CreateFolderArgs,
) {
  requireWrites(deps);
  await principal.storage.mkdir(args.path, { parents: true });
  return { created: args.path, url: folderUrl(deps.fdrivePublicUrl, args.path) };
}

// -------------------------------------------------------------- move_path

export interface MovePathArgs {
  readonly src: string;
  readonly dst: string;
}

/**
 * Records a move in `idx.moves` when both `src` and `dst` resolve within
 * the same configured root; silently does nothing otherwise (the move
 * itself already happened through `principal.storage`, this is best-effort
 * bookkeeping for `recent_moves`).
 */
export async function recordMoveIfInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
  args: MovePathArgs,
): Promise<void> {
  const resolvedSrc = toFsPath(ctx.scopes, args.src);
  const resolvedDst = toFsPath(ctx.scopes, args.dst);
  if (
    resolvedSrc === null ||
    resolvedDst === null ||
    resolvedSrc.rootName !== resolvedDst.rootName
  ) {
    return;
  }
  const rootId = ctx.rootIdByName.get(resolvedDst.rootName);
  if (rootId === undefined) {
    return;
  }
  await deps.indexQueries.recordMove({
    rootId,
    src: toIndexRelativePath(resolvedSrc.fsPath),
    dst: toIndexRelativePath(resolvedDst.fsPath),
    actor: "mcp",
  });
}

export async function runMovePath(deps: McpToolDeps, principal: Principal, args: MovePathArgs) {
  requireWrites(deps);
  await principal.storage.move(args.src, args.dst);

  const ctx = await resolveScopeContext(
    deps.indexQueries,
    deps.homeTemplate,
    deps.indexRootNames,
    principal.username,
  );
  if (ctx !== null) {
    await recordMoveIfInScope(deps, ctx, args);
  }

  // Best-effort hint only (SFTPGo's move response carries no entry kind):
  // a destination with no extension is treated as a folder, matching how
  // fdrive's own folder names are chosen in practice.
  const isDir = extensionOf(baseName(args.dst)) === "";
  return {
    moved: args.src,
    to: args.dst,
    url: isDir
      ? folderUrl(deps.fdrivePublicUrl, args.dst)
      : fileUrl(deps.fdrivePublicUrl, args.dst),
  };
}

// ----------------------------------------------------------- recent_moves

export interface RecentMovesArgs {
  readonly limit?: number | undefined;
}

/** `recent_moves`'s mapping logic given an already-resolved scope. Exported so tests can exercise the skip-on-out-of-scope branch directly. */
export async function recentMovesInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
  args: RecentMovesArgs,
) {
  const rows = await deps.indexQueries.recentMoves(
    ctx.scopePrefixes,
    "mcp",
    Math.max(1, Math.min(args.limit ?? 50, 500)),
  );

  const moves = rows
    .map((row) => {
      const src = row.src !== null ? virtualPathFor(ctx, row.rootId, row.src) : null;
      const dst = row.dst !== null ? virtualPathFor(ctx, row.rootId, row.dst) : null;
      if (src === null || dst === null) {
        return null;
      }
      return { at: row.at.toISOString(), src, dst };
    })
    .filter((row): row is { at: string; src: string; dst: string } => row !== null);

  return { moves };
}

export async function runRecentMoves(
  deps: McpToolDeps,
  principal: Principal,
  args: RecentMovesArgs,
) {
  const ctx = await resolveScopeContext(
    deps.indexQueries,
    deps.homeTemplate,
    deps.indexRootNames,
    principal.username,
  );
  if (ctx === null) {
    return { moves: [] };
  }
  return recentMovesInScope(deps, ctx, args);
}
