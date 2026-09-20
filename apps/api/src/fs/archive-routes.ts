import { createHash, randomUUID } from "node:crypto";
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
  defaultArchiveName,
  detectArchiveKind,
  isSafeSegment,
  isStorageError,
  joinPath,
  parentPath,
  safeEntryPath,
  stripArchiveExtension,
  uniqueCopyName,
} from "@fdrive/core";
import { activityRequestContext, recordFsAction } from "../activity/fs-context.js";
import { activityStat } from "../activity/service.js";
import { activityStorage } from "../activity/storage.js";
import type { AppHono, AuthedHono } from "../app.js";
import { compressToTemp } from "../archive/compress.js";
import { extractArchive } from "../archive/extract.js";
import { protectArchiveWrites } from "../archive/new-file-storage.ts";
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
import type { JobRunContext } from "../jobs/types.js";
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

    await recordFsAction(
      deps.activity,
      c,
      {
        action: "file.copy",
        requested: { path, targetPath: target, variant: "duplicate" },
        before: {
          path,
          kind: siblings.find((entry) => entry.path === path)?.kind === "dir" ? "dir" : "file",
        },
      },
      () => runStorageCall(() => principal.storage.copy(path, target)),
      () => ({ path: target }),
    );
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
    const body: JobsResponse = {
      jobs: deps.jobRunner.list(principal.identityId, principal.accountId),
    };
    return c.json(body);
  });

  authed.get(`${routePath(ROUTES.fs.jobs)}/:id`, (c) => {
    const principal = c.get("principal");
    const job = deps.jobRunner.get(c.req.param("id"), principal.identityId, principal.accountId);
    if (job === null) {
      throw new ApiHttpError("not_found", "job not found");
    }
    return c.json(JobStatus.parse(job));
  });

  authed.post(`${routePath(ROUTES.fs.jobs)}/:id/cancel`, (c) => {
    const principal = c.get("principal");
    const job = deps.jobRunner.cancel(c.req.param("id"), principal.identityId, principal.accountId);
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
  const name = body.name ?? defaultArchiveName(paths);
  const targetPath = joinPath(destination, `${name}${archiveExtensionFor(body.format)}`);
  if (await pathExists(principal.storage, targetPath)) {
    throw new ApiHttpError("conflict", `already exists: ${targetPath}`);
  }

  const job = await submitJob(deps, c, "compress", paths, targetPath, async (ctx, storage) => {
    const { file, size } = await compressToTemp({
      storage,
      paths,
      format: body.format,
      tmpDir: deps.tmpDir,
      signal: ctx.signal,
      report: ctx.report,
    });
    try {
      if (await pathExists(principal.storage, targetPath)) {
        throw new ApiHttpError("conflict", `already exists: ${targetPath}`);
      }
      await protectArchiveWrites(storage, principal.identityId).upload(
        targetPath,
        webStreamFromNodeReadable(createReadStream(file)),
        { contentLength: size, signal: ctx.signal, overwrite: false },
      );
    } finally {
      await rm(file, { force: true });
    }
    publishFsEvent(deps, principal, "create", [targetPath]);
    return { path: targetPath };
  });

  const responseBody: JobAccepted = { id: job.id, jobId: job.id };
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
      : safeEntryPath(parentPath(archivePath), stripArchiveExtension(baseName(archivePath)));
  if (destination === null)
    throw new ApiHttpError("bad_request", "archive has no safe destination name");

  const job = await submitJob(
    deps,
    c,
    "extract",
    [archivePath],
    destination,
    async (ctx, storage) => {
      const result = await extractArchive({
        storage: protectArchiveWrites(storage, principal.identityId),
        archivePath,
        destination,
        tmpDir: deps.tmpDir,
        signal: ctx.signal,
        report: ctx.report,
        maxBytes: deps.jobMaxBytes,
      });
      publishFsEvent(deps, principal, "create", [destination]);
      return result;
    },
  );

  const responseBody: JobAccepted = { id: job.id, jobId: job.id };
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

/**
 * Queues one archive job and journals its intent before any work starts. The
 * job's own storage is decorated, so every file the worker actually writes
 * becomes a child of the archive operation instead of an unattributed write.
 */
async function submitJob(
  deps: FsRoutesDeps,
  c: FsContext,
  kind: "compress" | "extract",
  paths: readonly string[],
  target: string,
  run: (
    context: JobRunContext,
    storage: Principal["storage"],
  ) => Promise<{ path: string; warning?: string }>,
): Promise<ReturnType<FsRoutesDeps["jobRunner"]["submit"]>> {
  const principal = c.get("principal");
  const context = activityRequestContext(c);
  const source = paths[0] ?? target;
  const requested = {
    path: source,
    targetPath: target,
    kind: kind === "extract" ? ("dir" as const) : ("file" as const),
    variant: "stored" as const,
  };
  const before = await activityStat(principal.storage, source);
  const operation = deps.activity
    ? await deps.activity.repo.begin({
        accountId: principal.accountId,
        identityId: principal.identityId,
        action: `archive.${kind}`,
        source: context.source,
        producerOperationId: context.producerOperationId ?? randomUUID(),
        requested,
        ...(before ? { before } : {}),
        requestDigest: createHash("sha256")
          .update(JSON.stringify([kind, paths, target]))
          .digest("hex"),
        subjects: paths.map((path) => ({ path, identityId: principal.identityId })),
      })
    : null;
  if (
    operation &&
    (operation.state !== "prepared" ||
      deps.jobRunner.get(operation.id, principal.identityId, principal.accountId))
  )
    throw new ApiHttpError("conflict", "This job was already submitted; check its activity");
  // Queue time is part of this process's lease. A job can wait behind long
  // transfers for longer than recovery's abandoned-operation threshold.
  const timer = operation
    ? setInterval(() => {
        void deps.activity?.repo
          .heartbeat(principal.accountId, operation.id)
          .catch(() => undefined);
      }, 15_000)
    : undefined;
  timer?.unref();
  try {
    return deps.jobRunner.submit({
      identityId: principal.identityId,
      accountId: principal.accountId,
      ...(operation
        ? {
            id: operation.id,
            onOutcome: async (state, result) => {
              try {
                // Some outputs may already be committed when a job fails, so a
                // failure with committed children is partial, never a clean loss.
                const committed =
                  (await deps.activity?.repo.completedChildren(
                    principal.accountId,
                    operation.id,
                  )) ?? 0;
                await deps.activity?.repo.finish(principal.accountId, operation.id, {
                  outcome:
                    state === "done"
                      ? "success"
                      : committed > 0
                        ? "partial"
                        : result.authorityRevoked
                          ? "denied"
                          : state === "cancelled"
                            ? "cancelled"
                            : "failed",
                  after: {
                    ...requested,
                    path: result.path ?? target,
                    size: result.bytes,
                    completedCount: committed,
                  },
                  ...(state === "done" ? {} : { errorCode: `job_${state}` }),
                });
              } finally {
                clearInterval(timer);
              }
            },
          }
        : {}),
      kind,
      ...(principal.verifyAuthority !== undefined ? { authorize: principal.verifyAuthority } : {}),
      run: async (ctx) => {
        const activity = deps.activity;
        if (!operation || !activity) return run(ctx, principal.storage);
        if (!(await activity.repo.claim(principal.accountId, operation.id)))
          throw new ApiHttpError("conflict", "This job was already submitted");
        return activity.withParent(principal, operation.id, () =>
          run(
            ctx,
            activityStorage(principal, activity, () => ({ source: context.source })),
          ),
        );
      },
    });
  } catch (error) {
    clearInterval(timer);
    if (operation)
      await deps.activity?.repo.finish(principal.accountId, operation.id, {
        outcome: "failed",
        errorCode: "queue_rejected",
      });
    if (error instanceof JobQueueFullError) {
      throw new ApiHttpError("rate_limited", error.message);
    }
    throw error;
  }
}
