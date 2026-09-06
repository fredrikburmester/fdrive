import { createReadStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ROUTES, ThumbQuery } from "@fdrive/contracts";
import { type CoreError, type HomeTemplate, normalizePath, toFsPath } from "@fdrive/core";
import type { IndexQueries } from "@fdrive/db";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import { toIndexRelativePath, usableScopesFor } from "../search/scopes.js";

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from `ROUTES.thumb`, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

/** Reads a generated thumbnail file from disk. Swapped out in tests for a fake. */
export interface ThumbFileReader {
  stat(path: string): Promise<{ size: number }>;
  readStream(path: string): ReadableStream<Uint8Array>;
}

/** The real reader, backed by `node:fs`. */
export function createNodeThumbFileReader(): ThumbFileReader {
  return {
    stat: (path) => fsStat(path),
    readStream: (path) => Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
  };
}

export interface ThumbRoutesDeps {
  readonly indexQueries: IndexQueries;
  readonly homeTemplate: HomeTemplate;
  readonly indexRootNames: ReadonlySet<string>;
  /** The directory the indexer writes thumbnails into. `undefined` disables the route entirely. */
  readonly thumbsDir: string | undefined;
  readonly fileReader?: ThumbFileReader;
}

const NOT_FOUND = () => new ApiHttpError("not_found", "thumbnail not found");

/**
 * Registers `GET /thumb?path=&size=256|1024`: resolves the virtual `path`
 * to an fs path via the caller's index scopes, looks up the file's sha256
 * in the index, then its cached thumbnail for `size`, and streams the
 * cached WebP from `FDRIVE_THUMBS_DIR/<storage_path>`. 404 whenever
 * thumbnails are not configured, the path cannot be resolved or is out of
 * scope, the file is not indexed or has no sha256, no thumbnail has been
 * generated for that size yet, or the cached file is missing from disk.
 */
export function registerThumbRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: ThumbRoutesDeps,
): void {
  const { authed } = groups;
  const fileReader = deps.fileReader ?? createNodeThumbFileReader();

  authed.get(routePath(ROUTES.thumb), async (c) => {
    if (deps.thumbsDir === undefined) {
      throw NOT_FOUND();
    }

    const result = ThumbQuery.safeParse(c.req.query());
    if (!result.success) {
      throw new ApiHttpError("bad_request", "invalid query", { issues: result.error.issues });
    }
    const size = Number(result.data.size) as 256 | 1024;

    let path: string;
    try {
      path = normalizePath(result.data.path);
    } catch (error) {
      const coreError = error as CoreError;
      throw new ApiHttpError("bad_request", coreError.message, coreError.details);
    }

    const principal = c.get("principal");
    const scopes = usableScopesFor(deps.homeTemplate, deps.indexRootNames, principal.username);
    if (scopes.length === 0) {
      throw NOT_FOUND();
    }

    const resolved = toFsPath(scopes, path);
    if (resolved === null) {
      throw NOT_FOUND();
    }

    const rootIds = await deps.indexQueries.rootIdsByName();
    const rootId = rootIds[resolved.rootName];
    if (rootId === undefined) {
      throw NOT_FOUND();
    }

    const relativePath = toIndexRelativePath(resolved.fsPath);
    const file = await deps.indexQueries.fileByPath(rootId, relativePath);
    if (file === null || file.sha256 === null) {
      throw NOT_FOUND();
    }

    const thumb = await deps.indexQueries.thumbnail(file.sha256, size);
    if (thumb === null) {
      throw NOT_FOUND();
    }

    const absolutePath = join(deps.thumbsDir, thumb.storagePath);
    let stat: { size: number };
    try {
      stat = await fileReader.stat(absolutePath);
    } catch {
      throw NOT_FOUND();
    }

    const body = fileReader.readStream(absolutePath);
    return c.body(body, 200, {
      "Content-Type": "image/webp",
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=86400",
      ETag: `"${file.sha256}"`,
    });
  });
}
