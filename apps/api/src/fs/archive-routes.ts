import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import {
  ArchiveEntriesResponse,
  CompressRequest,
  DuplicateRequest,
  EntryResponse,
  ExtractRequest,
  type JobAccepted,
  JobStatus,
  type JobsResponse,
  PathQuery,
  ROUTES,
} from "@fdrive/contracts";
import {
  archiveExtensionFor,
  baseName,
  detectArchiveKind,
  isSafeSegment,
  isStorageError,
  joinPath,
  parentPath,
  stripArchiveExtension,
  uniqueCopyName,
} from "@fdrive/core";
import type { AppHono, AuthedHono } from "../app.js";
import { compressToTemp } from "../archive/compress.js";
import { extractArchive } from "../archive/extract.js";
import {
  peekArchive,
  UnreadableArchiveError,
  UnsupportedPeekFormatError,
} from "../archive/peek.js";
import { isZstdSupported, webStreamFromNodeReadable } from "../archive/stream-utils.js";
import type { Principal } from "../auth/principal.js";
import { DEFAULT_ARCHIVE_PEEK_MAX_BYTES } from "../config.js";
import { ApiHttpError } from "../errors.js";
import { JobQueueFullError } from "../jobs/runner.js";
import {
  type FsContext,
  type FsRoutesDeps,
  normalizeOrThrow,
  parseBody,
  publishFsEvent,
  runStorageCall,
  serializeEntry,
  statEntry,
  toApiHttpError,
} from "./routes.js";

/**
 * `registerArchiveRoutes`'s own dependencies: every `FsRoutesDeps` field
 * (it is always called with the same object `registerFsRoutes` itself
 * received) plus `archivePeekMaxBytes`, which is not part of the shared
 * `FsRoutesDeps` interface (owned by `routes.ts`, outside this chunk's
 * scope). `composition.ts` attaches it to the object it passes through
 * `registerFsRoutes` via an intermediate variable rather than a fresh
 * object literal, so TypeScript's excess-property check (which only
 * applies to literals) never rejects it there; the field being optional
 * here makes a plain `FsRoutesDeps` value (every existing caller, in
 * `routes.ts` and in tests that do not care about this route) assignable
 * without any further change.
 */
type ArchiveRoutesDeps = FsRoutesDeps & { readonly archivePeekMaxBytes?: number };

const API_PREFIX = "/api/v1";

function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

/** True when every path in `paths` has the same parent directory. */
function sameParent(paths: readonly string[]): boolean {
  if (paths.length === 0) {
    return true;
  }
  const first = parentPath(paths[0] as string);
  return paths.every((path) => parentPath(path) === first);
}

/** Default archive base name (no extension) when the request does not give one. */
function defaultCompressName(paths: readonly string[], parent: string): string {
  if (paths.length === 1) {
    const name = baseName(paths[0] as string);
    return name.length > 0 ? name : "archive";
  }
  const parentName = baseName(parent);
  return parentName.length > 0 ? parentName : "archive";
}

/**
 * Confirms `path` names an existing directory, or throws the matching
 * `ApiHttpError`: `not_found` when it does not exist, `bad_request` when it
 * is a file.
 *
 * Tries `statFile` (a `HEAD`) first, not `list` (a `GET` to SFTPGo's
 * `dirs` endpoint): `statFile` is safe for every outcome here, a clean
 * stat when `path` is a file, or a clean `bad_request` when it is a
 * directory. Calling `list` directly on a path that turns out to be a
 * plain file would do the same job against the in-memory fake server this
 * is tested against, but a real SFTPGo server (verified against v2.7.5)
 * drops the connection outright in that case instead of responding with a
 * clean error (see `collectPath` in `../archive/compress.js` for the full
 * story), which fdrive cannot tell apart from an actual network failure.
 * `list` below only ever runs once `statFile` has ruled out `path` being a
 * file.
 */
async function assertIsDirectory(
  storage: Principal["storage"],
  path: string,
  label: string,
): Promise<void> {
  try {
    await storage.statFile(path);
  } catch (error) {
    if (isStorageError(error) && error.kind === "bad_request") {
      await runStorageCall(() => storage.list(path));
      return;
    }
    if (isStorageError(error)) {
      throw toApiHttpError(error);
    }
    throw error;
  }
  throw new ApiHttpError("bad_request", `${label} is not a folder: ${path}`);
}

/** True when `path` already exists (as a file or a directory). */
async function pathExists(storage: Principal["storage"], path: string): Promise<boolean> {
  try {
    await storage.statFile(path);
    return true;
  } catch (error) {
    if (isStorageError(error) && error.kind === "not_found") {
      return false;
    }
    if (isStorageError(error) && error.kind === "bad_request") {
      // statFile reports "bad_request" for a directory: it exists.
      return true;
    }
    if (isStorageError(error)) {
      throw toApiHttpError(error);
    }
    throw error;
  }
}

/**
 * Registers `/fs/duplicate`, `/fs/compress`, `/fs/extract`, and the
 * `/fs/jobs*` routes, called from `registerFsRoutes` (which already mounted
 * `authed` at `/api/v1`).
 */
export function registerArchiveRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: ArchiveRoutesDeps,
): void {
  const { authed } = groups;

  authed.post(routePath(ROUTES.fs.duplicate), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(DuplicateRequest, c);
    const path = normalizeOrThrow(body.path);
    const parent = parentPath(path);
    const siblings = await runStorageCall(() => principal.storage.list(parent));
    const existing = new Set(siblings.map((entry) => entry.name));
    const newName = uniqueCopyName(baseName(path), existing);
    const target = joinPath(parent, newName);

    await runStorageCall(() => principal.storage.copy(path, target));
    const entry = await statEntry(principal.storage, target);
    publishFsEvent(deps, principal, "copy", [path], [target]);
    const responseBody = EntryResponse.parse(serializeEntry(entry));
    return c.json(responseBody);
  });

  authed.post(routePath(ROUTES.fs.compress), (c) => handleCompress(c, deps));
  authed.post(routePath(ROUTES.fs.extract), (c) => handleExtract(c, deps));
  authed.get(routePath(ROUTES.fs.archiveEntries), (c) => handleArchiveEntries(c, deps));

  authed.get(routePath(ROUTES.fs.jobs), (c) => {
    const principal = c.get("principal");
    const body: JobsResponse = { jobs: deps.jobRunner.list(principal.identityId) };
    return c.json(body);
  });

  authed.get(`${routePath(ROUTES.fs.jobs)}/:id`, (c) => {
    const principal = c.get("principal");
    const job = deps.jobRunner.get(c.req.param("id"), principal.identityId);
    if (job === null) {
      throw new ApiHttpError("not_found", "job not found");
    }
    return c.json(JobStatus.parse(job));
  });

  authed.post(`${routePath(ROUTES.fs.jobs)}/:id/cancel`, (c) => {
    const principal = c.get("principal");
    const job = deps.jobRunner.cancel(c.req.param("id"), principal.identityId);
    if (job === null) {
      throw new ApiHttpError("not_found", "job not found");
    }
    return c.json(JobStatus.parse(job));
  });
}

async function handleCompress(c: FsContext, deps: FsRoutesDeps): Promise<Response> {
  const principal = c.get("principal");
  const body = await parseBody(CompressRequest, c);
  const paths = body.paths.map((path) => normalizeOrThrow(path));

  if (!sameParent(paths)) {
    throw new ApiHttpError("bad_request", "all paths must share the same parent folder");
  }
  if (body.format === "tar.zst" && !isZstdSupported()) {
    throw new ApiHttpError("bad_request", "tar.zst unsupported on this server");
  }

  // `paths` is non-empty (`CompressRequest.paths` has `.min(1)`), so `paths[0]` always exists.
  const parent = parentPath(paths[0] as string);
  const destination = body.destination !== undefined ? normalizeOrThrow(body.destination) : parent;
  await assertIsDirectory(principal.storage, destination, "destination");

  if (body.name !== undefined && !isSafeSegment(body.name)) {
    throw new ApiHttpError(
      "bad_request",
      "name must be a single file name without path separators",
    );
  }
  const name = body.name ?? defaultCompressName(paths, parent);
  const targetPath = joinPath(destination, `${name}${archiveExtensionFor(body.format)}`);
  if (await pathExists(principal.storage, targetPath)) {
    throw new ApiHttpError("conflict", `already exists: ${targetPath}`);
  }

  const job = submitJob(deps, principal, "compress", async (ctx) => {
    const { file, size } = await compressToTemp({
      storage: principal.storage,
      paths,
      format: body.format,
      tmpDir: deps.tmpDir,
      signal: ctx.signal,
      report: ctx.report,
    });
    try {
      await principal.storage.upload(
        targetPath,
        webStreamFromNodeReadable(createReadStream(file)),
        { contentLength: size, signal: ctx.signal },
      );
    } finally {
      await rm(file, { force: true });
    }
    publishFsEvent(deps, principal, "create", [targetPath]);
    return { path: targetPath };
  });

  const responseBody: JobAccepted = { jobId: job.id };
  return c.json(responseBody, 202);
}

async function handleExtract(c: FsContext, deps: FsRoutesDeps): Promise<Response> {
  const principal = c.get("principal");
  const body = await parseBody(ExtractRequest, c);
  const archivePath = normalizeOrThrow(body.path);

  const kind = detectArchiveKind(baseName(archivePath));
  if (kind === null) {
    throw new ApiHttpError("bad_request", `not a recognized archive: ${archivePath}`);
  }
  if (kind === "tar.zst" && !isZstdSupported()) {
    throw new ApiHttpError("bad_request", "tar.zst unsupported on this server");
  }

  // Confirms the archive exists (and is a file) before accepting the job.
  await runStorageCall(() => principal.storage.statFile(archivePath));

  const destination =
    body.destination !== undefined
      ? normalizeOrThrow(body.destination)
      : joinPath(parentPath(archivePath), stripArchiveExtension(baseName(archivePath)));

  const job = submitJob(deps, principal, "extract", async (ctx) => {
    const result = await extractArchive({
      storage: principal.storage,
      archivePath,
      destination,
      tmpDir: deps.tmpDir,
      signal: ctx.signal,
      report: ctx.report,
      maxBytes: deps.jobMaxBytes,
    });
    publishFsEvent(deps, principal, "create", [destination]);
    return result;
  });

  const responseBody: JobAccepted = { jobId: job.id };
  return c.json(responseBody, 202);
}

function parsePathQuery(query: Record<string, string | undefined>): PathQuery {
  const result = PathQuery.safeParse(query);
  if (!result.success) {
    throw new ApiHttpError("bad_request", "invalid query", { issues: result.error.issues });
  }
  return result.data;
}

/**
 * `GET /fs/archive-entries`: reads an archive's entries without extracting
 * it, via `peekArchive`. Maps `UnsupportedPeekFormatError` (an extension
 * `peekArchive` does not read) and `UnreadableArchiveError` (a recognized
 * but corrupt archive) both to `bad_request`, matching every other
 * storage-backed route's `StorageError` mapping otherwise.
 */
async function handleArchiveEntries(c: FsContext, deps: ArchiveRoutesDeps): Promise<Response> {
  const principal = c.get("principal");
  const query = parsePathQuery(c.req.query());
  const path = normalizeOrThrow(query.path);
  const maxBytes = deps.archivePeekMaxBytes ?? DEFAULT_ARCHIVE_PEEK_MAX_BYTES;

  let result: Awaited<ReturnType<typeof peekArchive>>;
  try {
    result = await peekArchive({
      storage: principal.storage,
      path,
      maxBytes,
      signal: c.req.raw.signal,
    });
  } catch (error) {
    if (error instanceof UnsupportedPeekFormatError || error instanceof UnreadableArchiveError) {
      throw new ApiHttpError("bad_request", error.message);
    }
    if (isStorageError(error)) {
      throw toApiHttpError(error);
    }
    throw error;
  }

  const responseBody: ArchiveEntriesResponse = ArchiveEntriesResponse.parse({
    format: result.format,
    entries: result.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      modifiedAt: entry.modifiedAt?.toISOString() ?? null,
    })),
    truncated: result.truncated,
  });
  return c.json(responseBody);
}

function submitJob(
  deps: FsRoutesDeps,
  principal: Principal,
  kind: "compress" | "extract",
  run: Parameters<FsRoutesDeps["jobRunner"]["submit"]>[0]["run"],
): ReturnType<FsRoutesDeps["jobRunner"]["submit"]> {
  try {
    return deps.jobRunner.submit({ identityId: principal.identityId, kind, run });
  } catch (error) {
    if (error instanceof JobQueueFullError) {
      throw new ApiHttpError("rate_limited", error.message);
    }
    throw error;
  }
}
