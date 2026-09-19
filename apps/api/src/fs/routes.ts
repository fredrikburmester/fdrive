import {
  CopyRequest,
  DeleteRequest,
  DownloadQuery,
  EntryResponse,
  type FsEntry,
  FsEvent,
  ListResponse,
  MkdirRequest,
  MODIFIED_AT_HEADER,
  MoveManyRequest,
  MoveManyResponse,
  type MoveManyResult,
  MoveRequest,
  OkResponse,
  PathQuery,
  RenameRequest,
  ROUTES,
  UploadQuery,
  ZipRequest,
} from "@fdrive/contracts";
import {
  baseName,
  type CoreError,
  changeBaseName,
  contentDisposition,
  extensionOf,
  type FileEntry,
  isInlinePreviewable,
  isStorageError,
  isUnderPath,
  mimeFromExtension,
  normalizePath,
  parentPath,
  parseRangeHeader,
  type StorageError,
  type StorageProvider,
} from "@fdrive/core";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppHono, AppVariables, AuthedHono } from "../app.js";
import type { Principal, PrincipalVariables } from "../auth/principal.js";
import { DEFAULT_JSON_MAX_BYTES } from "../config.js";
import { DESKTOP_INTERNAL_ROOT } from "../desktop/internal-root.js";
import { ApiHttpError } from "../errors.js";
import type { EventBus } from "../events/bus.js";
import type { JobRunner } from "../jobs/runner.js";
import type { MetadataService } from "../metadata/service.js";
import { registerArchiveRoutes } from "./archive-routes.js";
import { type FolderSizeRoutesDeps, registerFolderSizeRoutes } from "./folder-size.js";
import { relocatePath, requireUnoccupiedTarget } from "./mutations.js";

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from a `ROUTES.fs.*` path, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

export interface FsRoutesDeps {
  readonly bus: EventBus;
  readonly clock: () => Date;
  readonly jobRunner: JobRunner;
  /** Directory archive jobs spool temp files into. */
  readonly tmpDir: string;
  /** Total bytes a single extract job may read before it fails. */
  readonly jobMaxBytes: number;
  /**
   * Decorates `fs/list` and `fs/stat` entries with tag/favorite metadata and keeps tag,
   * favorite, and recent rows in sync with moves, renames, and deletes made
   * through these routes. Optional so route tests that do not exercise
   * metadata can omit it; `composition.ts` always wires the real service.
   */
  readonly metadata?: MetadataService;
  /**
   * The storage provider's recycle folder virtual path, when configured
   * Used to hide the provider-bound trash folder itself from `fs/list` and
   * to route deletes made while a trash
   * is available through `metadata.onTrashed` instead of `onDeleted`.
   */
  readonly trashPathForStorage?: (storage: StorageProvider) => string | null;
  /**
   * Cap on a JSON request body's bytes, passed to `parseBody` for every
   * route this function registers (zip, mkdir, move, copy, rename,
   * delete). Defaults to `DEFAULT_JSON_MAX_BYTES` when omitted; wire
   * `config.fdriveJsonMaxBytes` here to make `FDRIVE_JSON_MAX_BYTES`
   * effective for these routes.
   */
  readonly jsonMaxBytes?: number;
  /** Wires `GET /fs/folder-size`; see `folder-size.ts`'s `registerFolderSizeRoutes`. */
  readonly folderSize: FolderSizeRoutesDeps;
}

export type FsContext = Context<{ Variables: AppVariables & PrincipalVariables }>;

function parseQuery<T>(schema: z.ZodType<T>, query: Record<string, string | undefined>): T {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new ApiHttpError("bad_request", "invalid query", { issues: result.error.issues });
  }
  return result.data;
}

/**
 * Parses `c`'s JSON body against `schema`, throwing `bad_request` on invalid
 * JSON or a schema mismatch. Reads the body as a stream and throws
 * `payload_too_large` as soon as more than `maxBytes` have arrived, rather
 * than buffering an unbounded body first (the same approach as
 * `shares/routes.ts`'s `publicBody`). `maxBytes` defaults to
 * `DEFAULT_JSON_MAX_BYTES` (see `config.ts`'s `FDRIVE_JSON_MAX_BYTES`);
 * `registerFsRoutes` passes `deps.jsonMaxBytes` for the routes it registers,
 * so an operator-configured cap applies there even though other callers of
 * this function (trash, accounts, metadata, office, archive routes) do not
 * currently thread a config value through and keep the default.
 */
export async function parseBody<T>(
  schema: z.ZodType<T>,
  c: Context,
  maxBytes: number = DEFAULT_JSON_MAX_BYTES,
): Promise<T> {
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new ApiHttpError("payload_too_large", "Request body is too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks, size).toString("utf-8"));
  } catch {
    throw new ApiHttpError("bad_request", "invalid JSON body");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ApiHttpError("bad_request", "invalid body", { issues: result.error.issues });
  }
  return result.data;
}

/**
 * Normalizes a virtual path, mapping the `CoreError` `normalizePath` throws
 * on an invalid path (its only failure mode) into a `bad_request`.
 */
export function normalizeOrThrow(path: string): string {
  try {
    return normalizePath(path);
  } catch (error) {
    // `normalizePath` only ever throws `CoreError("invalid_path")`.
    const coreError = error as CoreError;
    throw new ApiHttpError("bad_request", coreError.message, coreError.details);
  }
}

/** Maps a `StorageError` to the `ApiHttpError` of the matching kind ("unauthorized" becomes "reauth_required"). */
export function toApiHttpError(error: StorageError): ApiHttpError {
  const kind = error.kind === "unauthorized" ? "reauth_required" : error.kind;
  return new ApiHttpError(kind, error.message, error.details);
}

/** Runs `fn`, mapping any `StorageError` it throws into the matching `ApiHttpError`. */
export async function runStorageCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isStorageError(error)) {
      throw toApiHttpError(error);
    }
    throw error;
  }
}

/**
 * Ensures nothing already exists at `target` before move, copy, or rename
 * ask the storage provider to relocate something there. The real
 * SFTPGo-backed provider's move and copy do not reliably report a conflict
 * for an occupied target themselves: verified against the real
 * drakkan/sftpgo:v2.7.5 container, moving or copying a file onto an
 * existing file silently overwrites it instead of failing (see
 * `packages/sftpgo`'s fake, fixed to match). A route that let that happen
 * would silently destroy whatever used to be at `target`, so it checks
 * first with `statFile` instead, mirroring the same check
 * `@fdrive/core`'s trash restore relies on (see
 * `packages/core/src/trash/recycle-folder-trash.ts`).
 *
 * `statFile` succeeding means a file is already there: conflict. A
 * directory is reported as `StorageError("bad_request")` by every
 * `StorageProvider` implementation: also a conflict. `"not_found"` means
 * the target is free. Any other storage error is mapped through
 * `toApiHttpError` like every other storage call; anything that is not a
 * `StorageError` propagates unchanged.
 */
export async function requireTargetFree(storage: StorageProvider, target: string): Promise<void> {
  await runStorageCall(() => requireUnoccupiedTarget(storage, target));
}

export function serializeEntry(entry: FileEntry): FsEntry {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    modifiedAt: entry.modifiedAt.toISOString(),
    ext: entry.ext,
    mime: mimeFromExtension(entry.ext),
  };
}

/**
 * Stats `path` via `storage.statFile`. When that fails because `path` is a
 * directory (a provider reports this as `bad_request`), falls back to
 * listing the parent directory and finding the matching entry there.
 */
export async function statEntry(storage: StorageProvider, path: string): Promise<FileEntry> {
  const stat = await runStorageCall(() => storage.stat(path));
  const name = baseName(path);
  return {
    name,
    path,
    kind: stat.kind,
    size: stat.size,
    modifiedAt: stat.modifiedAt ?? new Date(0),
    ext: stat.kind === "dir" ? "" : extensionOf(name),
  };
}

export function publishFsEvent(
  deps: Pick<FsRoutesDeps, "bus" | "clock">,
  principal: Principal,
  op: FsEvent["op"],
  paths: string[],
  targetPaths?: string[],
): void {
  const event: FsEvent = FsEvent.parse({
    type: "fs",
    op,
    identityId: principal.identityId,
    paths,
    at: deps.clock().toISOString(),
    ...(targetPaths !== undefined ? { targetPaths } : {}),
  });
  deps.bus.publish(event);
}

interface DownloadCallOpts {
  range?: { start: number; end?: number };
  signal?: AbortSignal;
  ifRange?: string;
}

function buildDownloadOpts(
  ifRangeHeader: string | undefined,
  signal: AbortSignal,
  range?: { start: number; end?: number },
): DownloadCallOpts {
  const opts: DownloadCallOpts = { signal };
  if (ifRangeHeader !== undefined) {
    opts.ifRange = ifRangeHeader;
  }
  if (range !== undefined) {
    opts.range = range;
  }
  return opts;
}

type DownloadResult = Awaited<ReturnType<StorageProvider["download"]>>;

type DownloadOutcome =
  | { kind: "stream"; result: DownloadResult }
  | { kind: "range-not-satisfiable"; size: number | null };

/**
 * Resolves a `GET/HEAD /fs/download` request into either a stream to
 * return, or a "range not satisfiable" outcome (416). When a `Range`
 * header is present, opportunistically stats the file first to know its
 * size (used to validate the range and, on an invalid range, to report it
 * in the 416's `Content-Range`); a failed stat here is not surfaced, since
 * the subsequent `download` call below will raise the real error itself.
 */
async function resolveDownload(
  storage: StorageProvider,
  path: string,
  rangeHeader: string | null,
  ifRangeHeader: string | undefined,
  signal: AbortSignal,
): Promise<DownloadOutcome> {
  if (rangeHeader === null) {
    const result = await runStorageCall(() =>
      storage.download(path, buildDownloadOpts(ifRangeHeader, signal)),
    );
    return { kind: "stream", result };
  }

  let knownSize: number | null = null;
  try {
    knownSize = (await storage.statFile(path)).size;
  } catch {
    knownSize = null;
  }

  const parsed = parseRangeHeader(rangeHeader, knownSize);
  if (parsed.kind === "invalid") {
    return { kind: "range-not-satisfiable", size: knownSize };
  }
  if (parsed.kind === "multiple") {
    const result = await runStorageCall(() => storage.download(path, { signal }));
    return { kind: "stream", result };
  }

  // `rangeHeader` is non-null here, so `parseRangeHeader` cannot have
  // returned its "none" variant (that only happens for a null header), and
  // the unsupported multi-range case returned the complete response above.
  const single = parsed as Extract<typeof parsed, { kind: "single" }>;
  const range =
    single.end !== undefined ? { start: single.start, end: single.end } : { start: single.start };
  const result = await runStorageCall(() =>
    storage.download(path, buildDownloadOpts(ifRangeHeader, signal, range)),
  );
  return { kind: "stream", result };
}

async function handleDownload(c: FsContext): Promise<Response> {
  const principal = c.get("principal");
  const query = parseQuery(DownloadQuery, c.req.query());
  const path = normalizeOrThrow(query.path);
  const rangeHeader = c.req.header("range") ?? null;
  const ifRangeHeader = c.req.header("if-range");

  const outcome = await resolveDownload(
    principal.storage,
    path,
    rangeHeader,
    ifRangeHeader,
    c.req.raw.signal,
  );

  if (outcome.kind === "range-not-satisfiable") {
    const headers: Record<string, string> =
      outcome.size !== null ? { "Content-Range": `bytes */${outcome.size}` } : {};
    return c.body(null, 416, headers);
  }

  const result = outcome.result;
  const mime =
    result.contentType ??
    mimeFromExtension(extensionOf(baseName(path))) ??
    "application/octet-stream";
  const inline = query.inline === "1" && isInlinePreviewable(mime);
  const disposition = contentDisposition(inline ? "inline" : "attachment", baseName(path));

  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": disposition,
    "Content-Security-Policy": "sandbox",
  };
  if (result.contentLength !== null) {
    headers["Content-Length"] = String(result.contentLength);
  }
  if (result.contentRange !== null) {
    headers["Content-Range"] = result.contentRange;
  }
  if (result.lastModified !== null) {
    headers["Last-Modified"] = result.lastModified.toUTCString();
  }

  if (c.req.method === "HEAD") {
    await result.body.cancel();
    return c.body(null, result.status, headers);
  }

  return c.body(result.body, result.status, headers);
}

/**
 * Registers every `/fs/*` route (list, stat, download, zip, upload, mkdir,
 * move, copy, rename, delete) on the authed group, using `ROUTES.fs.*`
 * (minus the `/api/v1` prefix, since `authed` is already mounted there).
 */
/**
 * Moves items in order, continuing past failures, never overwriting, and
 * reports each outcome. Used by `POST /fs/move-many` and by AI chat when a
 * move card is applied. With `createParents`, missing target folders are
 * created after the source was checked, so a move that cannot happen leaves
 * no empty folder behind.
 */
export async function moveMany(
  deps: Pick<FsRoutesDeps, "bus" | "clock" | "metadata">,
  principal: Principal,
  body: MoveManyRequest,
): Promise<MoveManyResult[]> {
  const results: MoveManyResult[] = [];
  const moved: { path: string; target: string }[] = [];
  const created: string[] = [];
  const readyParents = new Set<string>();

  /** Creates the target's missing parent folders, recording each one so every listing above them refreshes. */
  async function ensureParent(target: string): Promise<void> {
    const parent = parentPath(target);
    const missing: string[] = [];
    for (let folder = parent; folder !== "/" && !readyParents.has(folder); ) {
      try {
        await principal.storage.stat(folder);
        break;
      } catch (error) {
        if (!isStorageError(error) || error.kind !== "not_found") throw error;
        missing.unshift(folder);
        folder = parentPath(folder);
      }
    }
    if (missing.length > 0) {
      await principal.storage.mkdir(parent, { parents: true });
      created.push(...missing);
    }
    for (let folder = parent; folder !== "/"; folder = parentPath(folder)) readyParents.add(folder);
  }

  try {
    for (const item of body.items) {
      try {
        const path = normalizeOrThrow(item.path);
        const target = normalizeOrThrow(item.target);
        // Check the source first, so a move that cannot happen leaves no new empty folder behind.
        const source = await runStorageCall(() => principal.storage.stat(path));
        if (body.createParents === true && path !== target && !isUnderPath(path, target))
          await runStorageCall(() => ensureParent(target));
        await runStorageCall(() => relocatePath(principal.storage, "move", path, target));
        moved.push({ path, target });
        try {
          await deps.metadata?.onMoved(principal.identityId, path, target, source.kind === "dir");
          results.push({ ok: true, path, target });
        } catch {
          results.push({
            ok: true,
            path,
            target,
            warning: "Moved, but its tags, favorite or recent entry could not follow it.",
          });
        }
      } catch (error) {
        // Every storage call above goes through `runStorageCall`, so item failures arrive as `ApiHttpError`s.
        if (!(error instanceof ApiHttpError)) throw error;
        results.push({
          ok: false,
          path: item.path,
          target: item.target,
          error: { kind: error.kind, message: error.message },
        });
      }
    }
  } finally {
    if (created.length > 0) publishFsEvent(deps, principal, "mkdir", created);
    if (moved.length > 0)
      publishFsEvent(
        deps,
        principal,
        "move",
        moved.map((entry) => entry.path),
        moved.map((entry) => entry.target),
      );
  }
  return results;
}

export interface TrashManyResult {
  readonly path: string;
  readonly ok: boolean;
  readonly error?: { kind: string; message: string };
}

/**
 * Deletes items one by one, continuing past failures. Where the login's
 * storage has Trash, the deletes are recoverable and only recents are
 * dropped; otherwise every path-keyed metadata row goes with the item.
 */
export async function trashMany(
  deps: Pick<FsRoutesDeps, "bus" | "clock" | "metadata">,
  principal: Principal,
  items: readonly { path: string; kind: "file" | "dir" }[],
): Promise<TrashManyResult[]> {
  const results: TrashManyResult[] = [];
  const removed: string[] = [];
  try {
    for (const item of items) {
      try {
        const path = normalizeOrThrow(item.path);
        await runStorageCall(() =>
          item.kind === "dir"
            ? principal.storage.deleteDir(path)
            : principal.storage.deleteFile(path),
        );
        removed.push(path);
        try {
          if (principal.storage.trash !== undefined)
            await deps.metadata?.onTrashed(principal.identityId, path, item.kind === "dir");
          else await deps.metadata?.onDeleted(principal.identityId, path, item.kind === "dir");
        } catch {
          // The item is gone either way; stale metadata is repaired by the next listing.
        }
        results.push({ path, ok: true });
      } catch (error) {
        if (!(error instanceof ApiHttpError)) throw error;
        results.push({
          path: item.path,
          ok: false,
          error: { kind: error.kind, message: error.message },
        });
      }
    }
  } finally {
    if (removed.length > 0) publishFsEvent(deps, principal, "delete", removed);
  }
  return results;
}

export function registerFsRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: FsRoutesDeps,
): void {
  const { authed } = groups;
  const jsonMaxBytes = deps.jsonMaxBytes ?? DEFAULT_JSON_MAX_BYTES;

  authed.get(routePath(ROUTES.fs.list), async (c) => {
    const principal = c.get("principal");
    const query = parseQuery(PathQuery, c.req.query());
    const path = normalizeOrThrow(query.path);
    const entries = await runStorageCall(() => principal.storage.list(path));
    const trashPath = deps.trashPathForStorage?.(principal.storage);
    // The provider-bound trash folder and the Mac app's bookkeeping namespace are fdrive's own;
    // neither is a user folder, so the tree does not show them.
    const visible = entries.filter((entry) => {
      const entryPath = normalizeOrThrow(entry.path);
      return entryPath !== trashPath && entryPath !== DESKTOP_INTERNAL_ROOT;
    });
    const serialized = visible.map(serializeEntry);
    const decorated =
      deps.metadata !== undefined
        ? await deps.metadata.decorate(principal.identityId, serialized)
        : serialized;
    const body: ListResponse = ListResponse.parse({ path, entries: decorated });
    return c.json(body);
  });

  authed.get(routePath(ROUTES.fs.stat), async (c) => {
    const principal = c.get("principal");
    const query = parseQuery(PathQuery, c.req.query());
    const path = normalizeOrThrow(query.path);
    const entry = await statEntry(principal.storage, path);
    const serialized = serializeEntry(entry);
    const decorated =
      deps.metadata !== undefined
        ? await deps.metadata.decorate(principal.identityId, [serialized])
        : [serialized];
    const body: EntryResponse = EntryResponse.parse(decorated[0]);
    return c.json(body);
  });

  authed.get(routePath(ROUTES.fs.download), handleDownload);
  authed.on("HEAD", routePath(ROUTES.fs.download), handleDownload);

  authed.post(routePath(ROUTES.fs.zip), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(ZipRequest, c, jsonMaxBytes);
    const paths = body.paths.map((p) => normalizeOrThrow(p));
    const zip = principal.storage.zip;
    if (zip === undefined) {
      throw new ApiHttpError("unsupported", "this storage cannot build zip archives", {
        capability: "zip",
      });
    }
    const stream = await runStorageCall(() => zip(paths, { signal: c.req.raw.signal }));
    // `ZipRequest.paths` has `.min(1)`, so `paths[0]` always exists here.
    const firstPath = paths[0] as string;
    const derivedName = baseName(firstPath);
    const zipName = `${body.name ?? (derivedName.length > 0 ? derivedName : "download")}.zip`;
    return c.body(stream, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition("attachment", zipName),
    });
  });

  authed.put(routePath(ROUTES.fs.upload), async (c) => {
    const principal = c.get("principal");
    const query = parseQuery(UploadQuery, c.req.query());
    const path = normalizeOrThrow(query.path);

    const uploadOpts: {
      mkdirParents?: boolean;
      modifiedAt?: Date;
      contentLength?: number;
      signal?: AbortSignal;
    } = { signal: c.req.raw.signal };
    if (query.mkdirParents !== undefined) {
      uploadOpts.mkdirParents = query.mkdirParents === "true";
    }
    const modifiedAtHeader = c.req.header(MODIFIED_AT_HEADER);
    if (modifiedAtHeader !== undefined) {
      const modifiedAtMs = Number(modifiedAtHeader);
      if (Number.isFinite(modifiedAtMs)) {
        uploadOpts.modifiedAt = new Date(modifiedAtMs);
      }
    }
    const contentLengthHeader = c.req.header("content-length");
    if (contentLengthHeader !== undefined) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength)) {
        uploadOpts.contentLength = contentLength;
      }
    }

    await runStorageCall(() =>
      principal.storage.upload(path, c.req.raw.body ?? new Uint8Array(), uploadOpts),
    );

    const entry = await statEntry(principal.storage, path);
    publishFsEvent(deps, principal, "create", [path]);
    const body: EntryResponse = EntryResponse.parse(serializeEntry(entry));
    return c.json(body, 201);
  });

  authed.post(routePath(ROUTES.fs.mkdir), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(MkdirRequest, c, jsonMaxBytes);
    const path = normalizeOrThrow(body.path);
    await runStorageCall(() => principal.storage.mkdir(path));
    const entry = await statEntry(principal.storage, path);
    publishFsEvent(deps, principal, "mkdir", [path]);
    const responseBody: EntryResponse = EntryResponse.parse(serializeEntry(entry));
    return c.json(responseBody, 201);
  });

  authed.post(routePath(ROUTES.fs.move), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(MoveRequest, c, jsonMaxBytes);
    const path = normalizeOrThrow(body.path);
    const target = normalizeOrThrow(body.target);
    await runStorageCall(() => relocatePath(principal.storage, "move", path, target));
    const entry = await statEntry(principal.storage, target);
    if (deps.metadata !== undefined) {
      await deps.metadata.onMoved(principal.identityId, path, target, entry.kind === "dir");
    }
    publishFsEvent(deps, principal, "move", [path], [target]);
    const responseBody: EntryResponse = EntryResponse.parse(serializeEntry(entry));
    return c.json(responseBody);
  });

  authed.post(routePath(ROUTES.fs.moveMany), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(MoveManyRequest, c, jsonMaxBytes);
    return c.json(MoveManyResponse.parse({ results: await moveMany(deps, principal, body) }));
  });

  authed.post(routePath(ROUTES.fs.copy), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(CopyRequest, c, jsonMaxBytes);
    const path = normalizeOrThrow(body.path);
    const target = normalizeOrThrow(body.target);
    await runStorageCall(() => relocatePath(principal.storage, "copy", path, target));
    const entry = await statEntry(principal.storage, target);
    deps.metadata?.onCopied(principal.identityId, path, target);
    publishFsEvent(deps, principal, "copy", [path], [target]);
    const responseBody: EntryResponse = EntryResponse.parse(serializeEntry(entry));
    return c.json(responseBody);
  });

  authed.post(routePath(ROUTES.fs.rename), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(RenameRequest, c, jsonMaxBytes);
    const path = normalizeOrThrow(body.path);
    const target = changeBaseName(path, body.newName);
    await runStorageCall(() => relocatePath(principal.storage, "move", path, target));
    const entry = await statEntry(principal.storage, target);
    if (deps.metadata !== undefined) {
      await deps.metadata.onMoved(principal.identityId, path, target, entry.kind === "dir");
    }
    publishFsEvent(deps, principal, "move", [path], [target]);
    const responseBody: EntryResponse = EntryResponse.parse(serializeEntry(entry));
    return c.json(responseBody);
  });

  authed.post(routePath(ROUTES.fs.delete), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(DeleteRequest, c, jsonMaxBytes);
    const removed: string[] = [];
    try {
      for (const item of body.items) {
        const path = normalizeOrThrow(item.path);
        try {
          if (item.kind === "dir") {
            await principal.storage.deleteDir(path);
          } else {
            await principal.storage.deleteFile(path);
          }
        } catch (error) {
          if (isStorageError(error)) {
            const mapped = toApiHttpError(error);
            throw new ApiHttpError(mapped.kind, mapped.message, {
              ...(mapped.details ?? {}),
              failedPath: path,
            });
          }
          throw error;
        }
        removed.push(path);
        if (deps.metadata !== undefined) {
          if (principal.storage.trash !== undefined) {
            await deps.metadata.onTrashed(principal.identityId, path, item.kind === "dir");
          } else {
            await deps.metadata.onDeleted(principal.identityId, path, item.kind === "dir");
          }
        }
      }
    } finally {
      if (removed.length > 0) publishFsEvent(deps, principal, "delete", removed);
    }
    const body2: OkResponse = OkResponse.parse({ ok: true });
    return c.json(body2);
  });

  registerArchiveRoutes(groups, deps);
  registerFolderSizeRoutes(groups, deps.folderSize);
}
