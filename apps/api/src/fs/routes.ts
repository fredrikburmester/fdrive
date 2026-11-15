import { randomUUID } from "node:crypto";
import {
  CopyRequest,
  DeleteRequest,
  DownloadQuery,
  EntryResponse,
  type FsEntry,
  ListResponse,
  MkdirRequest,
  MODIFIED_AT_HEADER,
  MoveManyRequest,
  MoveManyResponse,
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
  type EntryStat,
  extensionOf,
  type FileEntry,
  isInlinePreviewable,
  isReservedPath,
  isStorageError,
  mimeFromExtension,
  normalizePath,
  parseRangeHeader,
  type StorageError,
  type StorageProvider,
} from "@fdrive/core";
import type { Context } from "hono";
import type { z } from "zod";
import { activityHeaders, activityRequestContext } from "../activity/fs-context.js";
import type { PersonalActivityService } from "../activity/service.js";
import { activityStream } from "../activity/streams.js";
import type { AppHono, AppVariables, AuthedHono } from "../app.js";
import type { PrincipalVariables } from "../auth/principal.js";
import { DEFAULT_JSON_MAX_BYTES } from "../config.js";
import { ApiHttpError } from "../errors.js";
import { type FileOperations, fileActor, moveMany } from "../files/operations.js";
import type { JobRunner } from "../jobs/runner.js";
import type { MetadataService } from "../metadata/service.js";
import { registerArchiveRoutes } from "./archive-routes.js";
import { type FolderSizeRoutesDeps, registerFolderSizeRoutes } from "./folder-size.js";

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from a `ROUTES.fs.*` path, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

export interface FsRoutesDeps {
  /** Absent in fixtures that do not exercise personal history; every route works without it. */
  readonly activity?: PersonalActivityService;
  /** Every change these routes make to files, and what follows it. */
  readonly files: FileOperations;
  readonly jobRunner: JobRunner;
  /** Directory archive jobs spool temp files into. */
  readonly tmpDir: string;
  /** Total bytes a single extract job may read before it fails. */
  readonly jobMaxBytes: number;
  /**
   * Decorates `fs/list` and `fs/stat` entries with tag and favorite
   * metadata. Optional so route tests that do not exercise it can omit it.
   */
  readonly metadata?: Pick<MetadataService, "decorate">;
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

export function parseQuery<T>(schema: z.ZodType<T>, query: Record<string, string | undefined>): T {
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

/** Maps a `StorageError` to the `ApiHttpError` of the same kind. */
export function toApiHttpError(error: StorageError): ApiHttpError {
  return new ApiHttpError(error.kind, error.message, error.details);
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

/** A header's value as a finite number, or `undefined` when absent or not one. */
function finiteHeader(value: string | undefined): number | undefined {
  const number = Number(value);
  return value === undefined || !Number.isFinite(number) ? undefined : number;
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
 * The entry at `path`, whatever its kind, named and pathed the way storage
 * spells it: a disk that ignores case or accent encoding (macOS) also finds
 * other spellings, and listings show the stored one.
 */
export function statEntry(storage: StorageProvider, path: string): Promise<EntryStat> {
  return runStorageCall(() => storage.stat(path));
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

export type DownloadOutcome =
  | { kind: "stream"; result: DownloadResult }
  | { kind: "range-not-satisfiable"; size: number | null };

/**
 * Resolves a download request (`/fs/download`, a public share's) into
 * either a stream to return, or a "range not satisfiable" outcome (416).
 * When a `Range` header is present, opportunistically stats the file first
 * to know its size (used to validate the range and, on an invalid range,
 * to report it in the 416's `Content-Range`); a failed stat here is not
 * surfaced, since the subsequent `download` call below will raise the real
 * error itself. Storage errors are left to the caller to map.
 */
export async function resolveDownload(
  storage: StorageProvider,
  path: string,
  rangeHeader: string | null,
  ifRangeHeader: string | undefined,
  signal: AbortSignal,
): Promise<DownloadOutcome> {
  if (rangeHeader === null) {
    const result = await storage.download(path, buildDownloadOpts(ifRangeHeader, signal));
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
    const result = await storage.download(path, { signal });
    return { kind: "stream", result };
  }

  // `rangeHeader` is non-null here, so `parseRangeHeader` cannot have
  // returned its "none" variant (that only happens for a null header), and
  // the unsupported multi-range case returned the complete response above.
  const single = parsed as Extract<typeof parsed, { kind: "single" }>;
  const range =
    single.end !== undefined ? { start: single.start, end: single.end } : { start: single.start };
  const result = await storage.download(path, buildDownloadOpts(ifRangeHeader, signal, range));
  return { kind: "stream", result };
}

async function handleDownload(c: FsContext, deps: FsRoutesDeps): Promise<Response> {
  const principal = c.get("principal");
  const query = parseQuery(DownloadQuery, c.req.query());
  const path = normalizeOrThrow(query.path);
  const rangeHeader = c.req.header("range") ?? null;
  const ifRangeHeader = c.req.header("if-range");

  const outcome = await runStorageCall(() =>
    resolveDownload(principal.storage, path, rangeHeader, ifRangeHeader, c.req.raw.signal),
  );

  if (outcome.kind === "range-not-satisfiable") {
    const headers: Record<string, string> =
      outcome.size !== null ? { "Content-Range": `bytes */${outcome.size}` } : {};
    return c.body(null, 416, headers);
  }

  const result = outcome.result;
  const mime = mimeFromExtension(extensionOf(baseName(path))) ?? "application/octet-stream";
  const inline = query.inline === "1" && isInlinePreviewable(mime);
  const disposition = contentDisposition(inline ? "inline" : "attachment", baseName(path));

  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Content-Length": String(result.contentLength),
    "Last-Modified": result.lastModified.toUTCString(),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": disposition,
    "Content-Security-Policy": "sandbox",
  };
  if (result.contentRange !== null) {
    headers["Content-Range"] = result.contentRange;
  }

  if (c.req.method === "HEAD") {
    await result.body.cancel();
    return c.body(null, result.status, headers);
  }

  // Inline bytes back a preview the browser decides to fetch; the explicit
  // preview gesture is reported separately. Anything served as an attachment
  // is bytes the person asked for, and only reaching EOF proves they were
  // delivered.
  const context = activityRequestContext(c);
  const body = inline
    ? result.body
    : await activityStream(deps.activity, principal, path, "file.download", result.body, {
        ...(context.producerOperationId ? { requestId: context.producerOperationId } : {}),
        source: context.source === "api" ? "api" : "web",
        partial: result.status === 206,
        expectedBytes: result.contentLength,
      });
  return c.body(body, result.status, headers);
}

/**
 * Registers every `/fs/*` route (list, stat, download, zip, upload, mkdir,
 * move, move-many, copy, rename, delete) on the authed group, using
 * `ROUTES.fs.*` (minus the `/api/v1` prefix, since `authed` is already
 * mounted there). Every change to files goes through `deps.files`.
 */
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
    // fdrive's own folders (the Trash, the Mac app's folder) are not the
    // user's, so the tree does not show them.
    const visible = entries.filter((entry) => !isReservedPath(entry.path));
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

  authed.get(routePath(ROUTES.fs.download), (c) => handleDownload(c, deps));
  authed.on("HEAD", routePath(ROUTES.fs.download), (c) => handleDownload(c, deps));

  authed.post(routePath(ROUTES.fs.zip), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(ZipRequest, c, jsonMaxBytes);
    const paths = body.paths.map((p) => normalizeOrThrow(p));
    const stream = await runStorageCall(() =>
      principal.storage.zip(paths, { signal: c.req.raw.signal }),
    );
    // `ZipRequest.paths` has `.min(1)`, so `paths[0]` always exists here.
    const firstPath = paths[0] as string;
    const derivedName = baseName(firstPath);
    const zipName = `${body.name ?? (derivedName.length > 0 ? derivedName : "download")}.zip`;
    const context = activityRequestContext(c);
    const recorded = await activityStream(
      deps.activity,
      principal,
      firstPath,
      "archive.compress",
      stream,
      {
        ...(context.producerOperationId ? { requestId: context.producerOperationId } : {}),
        source: context.source === "api" ? "api" : "web",
        subjects: paths.map((path) => ({ path, identityId: principal.identityId })),
      },
    );
    return c.body(recorded, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition("attachment", zipName),
    });
  });

  authed.put(routePath(ROUTES.fs.upload), async (c) => {
    const principal = c.get("principal");
    const query = parseQuery(UploadQuery, c.req.query());
    const path = normalizeOrThrow(query.path);

    // The browser asks before an upload replaces a file (its conflict
    // dialog) and saves over the file it opened; only a new file must not
    // take a name that is already there.
    const overwrite = query.intent !== "create";
    const signal = c.req.raw.signal;
    const body = c.req.raw.body ?? new Uint8Array();
    const contentLength = finiteHeader(c.req.header("content-length"));
    const sized = contentLength === undefined ? {} : { contentLength };
    const actor = fileActor(principal, activityRequestContext(c));
    const part =
      query.part === undefined ? undefined : { id: query.part, offset: Number(query.offset ?? 0) };
    // A piece before the last only grows the upload's part; the last one
    // publishes the file as one upload, recorded and announced once.
    if (part !== undefined && query.final !== "true") {
      await runStorageCall(() =>
        deps.files.uploadPart(actor, path, body, { part, overwrite, signal, ...sized }),
      );
      return c.body(null, 204);
    }
    const modifiedAtMs = finiteHeader(c.req.header(MODIFIED_AT_HEADER));
    const done = await runStorageCall(() =>
      deps.files.upload(actor, path, body, {
        action: `file.${query.intent ?? "upload"}`,
        overwrite,
        signal,
        ...sized,
        ...(part === undefined ? {} : { part }),
        ...(query.mkdirParents === undefined
          ? {}
          : { mkdirParents: query.mkdirParents === "true" }),
        ...(modifiedAtMs === undefined ? {} : { modifiedAt: new Date(modifiedAtMs) }),
      }),
    );
    activityHeaders(c, done.history);
    return c.json(EntryResponse.parse(serializeEntry(done.entry)), 201);
  });

  authed.post(routePath(ROUTES.fs.mkdir), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(MkdirRequest, c, jsonMaxBytes);
    const path = normalizeOrThrow(body.path);
    const done = await runStorageCall(() =>
      deps.files.mkdir(fileActor(principal, activityRequestContext(c)), path),
    );
    activityHeaders(c, done.history);
    const responseBody: EntryResponse = EntryResponse.parse(serializeEntry(done.entry));
    return c.json(responseBody, 201);
  });

  /** Moves or renames one item and answers with where it is now. */
  async function moveOne(
    c: FsContext,
    path: string,
    target: string,
    action: "file.move" | "file.rename",
  ): Promise<Response> {
    const principal = c.get("principal");
    const done = await runStorageCall(() =>
      deps.files.move(fileActor(principal, activityRequestContext(c)), path, target, { action }),
    );
    activityHeaders(c, done.history);
    const responseBody: EntryResponse = EntryResponse.parse(serializeEntry(done.entry));
    return c.json(responseBody);
  }

  authed.post(routePath(ROUTES.fs.move), async (c) => {
    const body = await parseBody(MoveRequest, c, jsonMaxBytes);
    return moveOne(c, normalizeOrThrow(body.path), normalizeOrThrow(body.target), "file.move");
  });

  authed.post(routePath(ROUTES.fs.moveMany), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(MoveManyRequest, c, jsonMaxBytes);
    return c.json(
      MoveManyResponse.parse({
        results: await moveMany(
          deps.files,
          principal,
          body,
          activityRequestContext(c),
          "file.move",
          normalizeOrThrow,
        ),
      }),
    );
  });

  authed.post(routePath(ROUTES.fs.copy), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(CopyRequest, c, jsonMaxBytes);
    const path = normalizeOrThrow(body.path);
    const target = normalizeOrThrow(body.target);
    const done = await runStorageCall(() =>
      deps.files.copy(fileActor(principal, activityRequestContext(c)), path, target),
    );
    activityHeaders(c, done.history);
    const responseBody: EntryResponse = EntryResponse.parse(serializeEntry(done.entry));
    return c.json(responseBody);
  });

  authed.post(routePath(ROUTES.fs.rename), async (c) => {
    const body = await parseBody(RenameRequest, c, jsonMaxBytes);
    const path = normalizeOrThrow(body.path);
    return moveOne(c, path, changeBaseName(path, body.newName), "file.rename");
  });

  authed.post(routePath(ROUTES.fs.delete), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(DeleteRequest, c, jsonMaxBytes);
    const context = activityRequestContext(c);
    const batchId = context.batchId ?? randomUUID();
    const operationBase = context.producerOperationId ?? randomUUID();
    for (const [index, item] of body.items.entries()) {
      const path = normalizeOrThrow(item.path);
      try {
        await deps.files.trash(
          fileActor(principal, {
            ...context,
            producerOperationId: `${operationBase}:${index}`,
            batchId,
          }),
          path,
        );
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
    }
    const body2: OkResponse = OkResponse.parse({ ok: true });
    return c.json(body2);
  });

  registerArchiveRoutes(groups, deps);
  registerFolderSizeRoutes(groups, deps.folderSize);
}
