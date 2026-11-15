import { createReadStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ThumbSize } from "@fdrive/contracts";
import type { IndexQueries } from "@fdrive/db";
import type { Context } from "hono";
import { ApiHttpError } from "../errors.js";
import { toIndexRelativePath } from "../search/scopes.js";

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

/**
 * Every failure this tail can hit answers the same bare 404: whichever
 * caller resolved a `(rootName, fsPath)` pair already decided that path is
 * theirs to see, and a thumbnail miss (not indexed, no thumbnail for that
 * size, cache file gone) is not information either caller should leak in
 * its response.
 */
export const THUMB_NOT_FOUND = (): ApiHttpError =>
  new ApiHttpError("not_found", "thumbnail not found");

export interface ServeThumbDeps {
  readonly indexQueries: Pick<IndexQueries, "rootIdsByName" | "fileByPath" | "thumbnail">;
  readonly thumbsDir: string;
  readonly fileReader: ThumbFileReader;
}

/** The already-resolved, already-authorized location this tail streams a thumbnail for. */
export interface ThumbTarget {
  readonly rootName: string;
  readonly fsPath: string;
  readonly size: ThumbSize;
}

/**
 * The serving tail shared by the authed thumb route and the public share
 * thumb route, once each has independently resolved and authorized a
 * `(rootName, fsPath)` pair its own way: looks up the file's sha256 in the
 * index, then its cached thumbnail for `size`, and streams the cached WebP
 * from `thumbsDir/<storage_path>` with `Content-Type: image/webp`. The
 * browser may keep it (`Cache-Control: private, no-cache`) but asks again on
 * every use with the file's sha256 as `ETag`: the same file answers `304`
 * without a body, while a changed file, or a permission or mapping change,
 * is never served stale. 404 when the root is not configured, the file is
 * not indexed or has no sha256, no thumbnail has been generated for that
 * size yet, or the cached file is missing from disk.
 */
export async function serveThumb(
  c: Context,
  deps: ServeThumbDeps,
  target: ThumbTarget,
): Promise<Response> {
  const rootIds = await deps.indexQueries.rootIdsByName();
  const rootId = rootIds[target.rootName];
  if (rootId === undefined) {
    throw THUMB_NOT_FOUND();
  }

  const relativePath = toIndexRelativePath(target.fsPath);
  const file = await deps.indexQueries.fileByPath(rootId, relativePath);
  if (file === null || file.sha256 === null) {
    throw THUMB_NOT_FOUND();
  }

  const thumb = await deps.indexQueries.thumbnail(file.sha256, target.size);
  if (thumb === null) {
    throw THUMB_NOT_FOUND();
  }
  const etag = `"${file.sha256}"`;
  const cache = { "Cache-Control": "private, no-cache", ETag: etag };
  if (c.req.header("if-none-match") === etag) {
    return c.body(null, 304, cache);
  }

  const absolutePath = join(deps.thumbsDir, thumb.storagePath);
  let stat: { size: number };
  try {
    stat = await deps.fileReader.stat(absolutePath);
  } catch {
    throw THUMB_NOT_FOUND();
  }

  const body = deps.fileReader.readStream(absolutePath);
  return c.body(body, 200, {
    "Content-Type": "image/webp",
    "Content-Length": String(stat.size),
    ...cache,
  });
}
