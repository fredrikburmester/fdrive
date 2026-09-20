import { isUnderPath, normalizePath, parseSearchFilters, type Scope, toFsPath } from "@fdrive/core";
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
import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import type { VerifiedUnavailableReason } from "../scoping/types.ts";
import type { ImageSearchService } from "../search/image-service.ts";
import { toIndexRelativePath } from "../search/scopes.js";
import type { SearchService } from "../search/service.js";
import {
  assertMutablePath,
  canBrowsePath,
  canOrganize,
  canReadPath,
  ordinaryPath,
  tokenScopes,
} from "./access.ts";
import { liveFileInfo, readFileTextDirect } from "./content.ts";
import {
  isoFromNs,
  moveDestinationKind,
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
  readonly indexerClient: IndexerExtractClient | null;
  readonly writesEnabled: boolean;
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
function indexUnavailableMessage(reason: VerifiedUnavailableReason | "no_roots"): string {
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
interface AuthorizedFiles {
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
async function authorizeIndexedFiles(
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
 * Lists a folder directly through `principal.storage`, authorized natively
 * by the storage provider itself (SFTPGo permissions), independent of index
 * availability: this tool never consults `ScopeResolver` or `IndexQueries`.
 * A configured recycle folder is the one provider-backed location withheld
 * from ordinary browsing; direct requests into it fail before storage is
 * touched, and its entry is removed before pagination. The listing is taken
 * at the normalized path the Trash check ran against, never the raw
 * argument, so the folder read is always the one that was checked.
 */
export async function runListDirectory(
  deps: TrashPathDeps & Partial<Pick<McpToolDeps, "publicUrl">>,
  principal: Principal,
  args: ListDirectoryArgs,
) {
  const path = normalizePath(args.path ?? "/");
  if (!canBrowsePath(principal, path))
    throw new McpToolError("path is outside this token's allowed folders");
  const trashPath = currentTrashPath(deps, principal);
  if (trashPath !== null && (path === trashPath || isUnderPath(trashPath, path))) {
    throw new McpToolError("path is in the configured Trash folder");
  }

  const limit = Math.max(1, Math.min(args.limit ?? 300, 2000));
  const entries = await principal.storage.list(path);
  const notTrashed =
    trashPath === null
      ? entries
      : entries.filter((entry) => {
          const entryPath = normalizePath(entry.path);
          return entryPath !== trashPath && !isUnderPath(trashPath, entryPath);
        });
  const visible = notTrashed.filter((entry) =>
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

// -------------------------------------------------------- read_file_text

export interface ReadFileTextArgs {
  readonly path: string;
  readonly offset?: number | undefined;
  readonly max_chars?: number | undefined;
}

/**
 * `read_file_text`'s logic given an already-resolved scope list and
 * authorizer. Exported so tests can exercise the out-of-scope and
 * read-denied branches with a hand-built scope. The path must round-trip
 * and pass a live download check before extraction is ever attempted:
 * listing/stat alone (or a scope that merely contains the path) is not
 * proof of read permission.
 */
export async function readFileTextWithScopes(
  deps: McpToolDeps,
  scopes: readonly Scope[],
  authorizer: ReadAuthorizer,
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
  const roundTripped = roundTripVirtualPath(scopes, resolved.rootName, resolved.fsPath);
  if (roundTripped === null) {
    throw new McpToolError("path is outside this identity's scope");
  }
  const authResult = await authorizer.authorize({ path: roundTripped, kind: "file" });
  if (!authResult.allowed) {
    throw new McpToolError("path is outside this identity's scope");
  }

  const extracted = await deps.indexerClient.extract({
    root: resolved.rootName,
    path: toIndexRelativePath(resolved.fsPath),
  });
  if (extracted === null) {
    throw new McpToolError("failed to extract text (indexer unreachable or unsupported file)");
  }

  const publicUrl = await deps.publicUrl();
  if (extracted.text.length === 0) {
    return {
      path: args.path,
      url: fileUrl(publicUrl, args.path),
      status: extracted.status,
      text: "",
    };
  }

  const page = pageText(extracted.text, args.offset ?? 0, args.max_chars ?? 8000);
  return {
    path: args.path,
    url: fileUrl(publicUrl, args.path),
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
  if (principal.tokenAccess !== undefined) return readFileTextDirect(deps, principal, args);
  const path = normalizePath(args.path);
  const trashPath = currentTrashPath(deps, principal);
  if (trashPath !== null && (path === trashPath || isUnderPath(trashPath, path))) {
    throw new McpToolError("path is in the configured Trash folder");
  }
  const identity = await deps.identities.get(principal.identityId);
  const verified =
    identity === null
      ? ({ available: false, reason: "no_connection" } as const)
      : await deps.scopeResolver.verifiedIndexScopes(identity);
  if (!verified.available) {
    throw new McpToolError(indexUnavailableMessage(verified.reason));
  }
  const authorizer = createReadAuthorizer({ storage: principal.storage });
  return readFileTextWithScopes(deps, tokenScopes(principal, verified.scopes), authorizer, {
    ...args,
    path,
  });
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
    const copies = await deps.indexQueries.filesBySha256(ctx.scopePrefixes, file.sha256, file.id);
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

export async function runFileInfo(deps: McpToolDeps, principal: Principal, args: FileInfoArgs) {
  if (principal.tokenAccess !== undefined) return liveFileInfo(deps, principal, args.path);
  const { ctx, authorizer } = await requireScope(deps, principal);
  return fileInfoInScope(deps, ctx, authorizer, args);
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
async function authorizeDuplicateGroups(
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
    {},
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
    {},
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
    writes_enabled: deps.writesEnabled,
    ...(partial ? { partial: true } : {}),
  };
}

export async function runIndexStats(deps: McpToolDeps, principal: Principal) {
  const { ctx, authorizer } = await requireScope(deps, principal);
  return indexStatsInScope(
    { ...deps, writesEnabled: canOrganize(principal, deps.writesEnabled) },
    ctx,
    authorizer,
  );
}

// ----------------------------------------------------------- create_folder

export interface CreateFolderArgs {
  readonly path: string;
}

function requireWrites(deps: McpToolDeps, principal: Principal): void {
  if (!canOrganize(principal, deps.writesEnabled)) {
    throw new McpToolError(
      principal.tokenAccess === undefined
        ? "write tools are disabled (FDRIVE_MCP_WRITES=false)"
        : "this token does not allow organize operations",
    );
  }
}

/**
 * Resolves the caller's verified scopes for a write. Unlike `requireScope`
 * this needs no index rows (writes work before anything is indexed), only
 * the identity's verified scope list, so it stays available while the
 * index is empty or behind.
 */
async function requireVerifiedScopes(
  deps: McpToolDeps,
  principal: Principal,
): Promise<readonly Scope[]> {
  const identity = await deps.identities.get(principal.identityId);
  const verified =
    identity === null
      ? ({ available: false, reason: "no_connection" } as const)
      : await deps.scopeResolver.verifiedIndexScopes(identity);
  if (!verified.available) {
    throw new McpToolError(indexUnavailableMessage(verified.reason));
  }
  return tokenScopes(principal, verified.scopes);
}

/**
 * Returns the admitted path in the coordinates `principal.storage` speaks
 * (the identity's virtual filesystem, the same space `ScopeResolver` lists
 * through and every `ReadAuthorizer` target uses). Throws unless `path`
 * lies inside the caller's verified scope, survives the virtual round trip
 * (so a location shadowed by a more specific override is never written
 * through the wrong identity), and is not in the trash. The same admission
 * every read tool applies before it returns content, so an MCP token can
 * never write where fdrive itself would refuse to look.
 *
 * Callers must hand the returned path to storage, never the argument they
 * passed in: admission is decided on the normalized, round-tripped path,
 * while `@fdrive/sftpgo` forwards whatever string it is given verbatim
 * (`assertValidPath` resolves no ".", ".." or repeated separator). Writing
 * through the raw argument would send a path that was never the one checked.
 */
function assertWritablePath(
  scopes: readonly Scope[],
  trashPath: string | null,
  path: string,
  label: string,
): string {
  const resolved = toFsPath(scopes, path);
  const virtualPath =
    resolved === null ? null : roundTripVirtualPath(scopes, resolved.rootName, resolved.fsPath);
  if (
    virtualPath === null ||
    (trashPath !== null && (virtualPath === trashPath || isUnderPath(trashPath, virtualPath)))
  ) {
    throw new McpToolError(`${label} is outside this identity's scope`);
  }
  return virtualPath;
}

/**
 * Creates a folder through `principal.storage` once `args.path` passes the
 * verified-scope admission (`assertWritablePath`). The folder is created at
 * the admitted path, not at the raw argument, so the location written is
 * always the one that was checked. Works without any index rows, but never
 * without verified scopes.
 */
export async function runCreateFolder(
  deps: McpToolDeps,
  principal: Principal,
  args: CreateFolderArgs,
) {
  requireWrites(deps, principal);
  const scopes =
    principal.tokenAccess === undefined ? await requireVerifiedScopes(deps, principal) : [];
  const path =
    principal.tokenAccess === undefined
      ? assertWritablePath(scopes, currentTrashPath(deps, principal), args.path, "path")
      : ordinaryPath(deps, principal, args.path);
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

/**
 * Moves or renames a path through `principal.storage` once both `src` and
 * `dst` pass the verified-scope admission (`assertWritablePath`). Both ends
 * of the move use the admitted paths, not the raw arguments, so the
 * locations touched are always the ones that were checked. Works without
 * any index rows, but never without verified scopes. Best-effort records
 * the move in `idx.moves` afterward when the index knows the root.
 */
export async function runMovePath(deps: McpToolDeps, principal: Principal, args: MovePathArgs) {
  requireWrites(deps, principal);
  const scopes =
    principal.tokenAccess === undefined ? await requireVerifiedScopes(deps, principal) : [];
  const trashPath = currentTrashPath(deps, principal);
  const src =
    principal.tokenAccess === undefined
      ? assertWritablePath(scopes, trashPath, args.src, "src")
      : ordinaryPath(deps, principal, args.src);
  const dst =
    principal.tokenAccess === undefined
      ? assertWritablePath(scopes, trashPath, args.dst, "dst")
      : ordinaryPath(deps, principal, args.dst);
  assertMutablePath(principal, src, trashPath);
  const isDir = (await principal.storage.stat(src)).kind === "dir";
  const publicUrl = await deps.publicUrl();
  await relocatePath(principal.storage, "move", src, dst);
  const warnings: string[] = [];
  if (src !== dst) {
    try {
      await deps.onMutation?.(principal, { kind: "move", path: src, target: dst, isDir });
    } catch {
      warnings.push("File moved, but metadata or live updates could not be updated.");
    }
    try {
      let auditScopes = scopes;
      if (principal.tokenAccess !== undefined) {
        const identity = await deps.identities.get(principal.identityId);
        const verified =
          identity === null ? null : await deps.scopeResolver.verifiedIndexScopes(identity);
        auditScopes = verified?.available ? tokenScopes(principal, verified.scopes) : [];
      }
      const ctx = await resolveScopeContext(deps.indexQueries, auditScopes, trashPath);
      if (ctx !== null) await recordMoveIfInScope(deps, ctx, { src, dst });
    } catch {
      warnings.push("File moved, but move history could not be recorded.");
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

/**
 * `recent_moves`'s mapping logic given an already-resolved scope and
 * authorizer. Exported so tests can exercise the skip-on-out-of-scope and
 * skip-on-read-denied branches directly. Both `src` and `dst` must
 * round-trip; only `dst` must additionally pass a live read check (`src`
 * has typically already moved away by the time this runs, so it is never
 * live-checked, only round-tripped so a shadowed source is never
 * disclosed).
 */
export async function recentMovesInScope(
  deps: McpToolDeps,
  ctx: ScopeContext,
  authorizer: ReadAuthorizer,
  args: RecentMovesArgs,
  storage?: Principal["storage"],
) {
  const rows = await deps.indexQueries.recentMoves(
    ctx.scopePrefixes,
    "mcp",
    Math.max(1, Math.min(args.limit ?? 50, 500)),
  );
  const capped = rows.slice(0, MAX_CANDIDATE_FILES);
  let partial = rows.length > capped.length;

  const resolved = await Promise.all(
    capped.map(async (row): Promise<{ at: string; src: string; dst: string } | null> => {
      if (row.src === null || row.dst === null) {
        return null;
      }
      const src = virtualPathFor(ctx, row.rootId, row.src);
      const dst = virtualPathFor(ctx, row.rootId, row.dst);
      if (src === null || dst === null) {
        return null;
      }
      let kind = moveDestinationKind(dst);
      if (storage !== undefined) {
        try {
          const stat = await storage.stat(dst);
          if (stat.kind !== "file" && stat.kind !== "dir") return null;
          kind = stat.kind;
        } catch {
          return null;
        }
      }
      const authResult = await authorizer.authorize({ path: dst, kind });
      if (!authResult.allowed) {
        return null;
      }
      return { at: row.at.toISOString(), src, dst };
    }),
  );

  const moves: { at: string; src: string; dst: string }[] = [];
  for (const entry of resolved) {
    if (entry === null) {
      partial = true;
      continue;
    }
    moves.push(entry);
  }

  return { moves, ...(partial ? { partial: true } : {}) };
}

export async function runRecentMoves(
  deps: McpToolDeps,
  principal: Principal,
  args: RecentMovesArgs,
) {
  const identity = await deps.identities.get(principal.identityId);
  const verified =
    identity === null
      ? { available: false as const }
      : await deps.scopeResolver.verifiedIndexScopes(identity);
  if (!verified.available) {
    return { moves: [] };
  }
  const ctx = await resolveScopeContext(
    deps.indexQueries,
    tokenScopes(principal, verified.scopes),
    currentTrashPath(deps, principal),
  );
  if (ctx === null) {
    return { moves: [] };
  }
  const authorizer = createReadAuthorizer({ storage: principal.storage });
  return recentMovesInScope(deps, ctx, authorizer, args, principal.storage);
}
