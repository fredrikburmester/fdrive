import { createGunzip, createZstdDecompress } from "node:zlib";
import type { ArchiveKind } from "@fdrive/core";
import * as tar from "tar-stream";
import { buildPeekEntry, type PeekEntry } from "./peek-entry.js";
import { nodeReadableFromWeb } from "./stream-utils.js";

export type TarCompression = "none" | "gzip" | "zstd";

/** Maps a peekable tar-family `ArchiveKind` to its decompression, or `null`
 * for a kind this module does not read (`zip`, a bare `gz`). */
export function tarCompressionFor(kind: ArchiveKind): TarCompression | null {
  switch (kind) {
    case "tar":
      return "none";
    case "tar.gz":
      return "gzip";
    case "tar.zst":
      return "zstd";
    default:
      return null;
  }
}

export interface TarPeekResult {
  readonly entries: PeekEntry[];
  readonly truncated: boolean;
}

/** True for the tar entry types `peekArchive` reports; every other type
 * (symlinks, hard links, device files, pax headers, ...) is skipped. */
function isRelevantTarEntry(type: tar.Headers["type"]): boolean {
  return type === "file" || type === "directory";
}

/**
 * Streams `body` (a tar, optionally gzip- or zstd-compressed per
 * `compression`) through `tar-stream`, collecting up to `maxEntries`
 * file/directory headers. Never reads an entry's content
 * (`entryStream.resume()` discards it immediately) and never writes
 * anything to disk. Stops early, reporting `truncated: true`, once either
 * `maxEntries` relevant entries have been collected or more than
 * `maxBytes` of the underlying (still-compressed) stream has been read;
 * a natural end of the tar before either limit reports `truncated: false`.
 */
export async function collectTarPeekEntries(
  body: ReadableStream<Uint8Array>,
  compression: TarCompression,
  maxBytes: number,
  maxEntries: number,
): Promise<TarPeekResult> {
  const nodeStream = nodeReadableFromWeb(body);
  const decompressor =
    compression === "gzip"
      ? createGunzip()
      : compression === "zstd"
        ? createZstdDecompress()
        : null;
  const extractStream = tar.extract();
  const collected: PeekEntry[] = [];
  let truncated = false;
  let bytes = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    function finish(): void {
      if (!settled) {
        settled = true;
        resolve();
      }
    }
    function fail(error: unknown): void {
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
    function stopEarly(): void {
      if (truncated) return;
      truncated = true;
      nodeStream.destroy();
      decompressor?.destroy();
      extractStream.destroy();
      finish();
    }

    nodeStream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stopEarly();
    });
    // `.pipe()` never forwards a source error to its destination on its
    // own (see the same comment in `archive/extract.ts`): without this,
    // a corrupt download would leave the chain waiting forever instead of
    // failing.
    nodeStream.once("error", (error) => {
      if (!truncated) fail(error);
    });

    const source = decompressor ? nodeStream.pipe(decompressor) : nodeStream;
    if (decompressor) {
      source.once("error", (error) => {
        if (!truncated) fail(error);
      });
    }
    source.pipe(extractStream);

    extractStream.on("error", (error) => {
      if (!truncated) fail(error);
    });
    extractStream.on("finish", finish);
    extractStream.on("entry", (header, entryStream, next) => {
      entryStream.resume();
      const relevant = isRelevantTarEntry(header.type);
      if (relevant && collected.length >= maxEntries) {
        stopEarly();
        return;
      }
      if (relevant) {
        collected.push(
          buildPeekEntry(
            header.name,
            header.type === "directory",
            header.size ?? 0,
            header.mtime ?? null,
          ),
        );
      }
      next();
    });
  });

  return { entries: collected, truncated };
}
