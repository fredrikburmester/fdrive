import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StorageProvider } from "@fdrive/core";
import { WopiError } from "./errors.ts";
import { deriveFileVersion } from "./protocol/version.ts";

export function boundedStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let size = 0;
  let stopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  function cleanup() {
    signal.removeEventListener("abort", abort);
  }
  function abort() {
    if (stopped) return;
    stopped = true;
    cleanup();
    controller.error(new WopiError(408));
    void reader.cancel().catch(() => undefined);
  }
  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(c) {
      try {
        const next = await reader.read();
        if (stopped) return;
        if (next.done) {
          stopped = true;
          cleanup();
          c.close();
          reader.releaseLock();
          return;
        }
        size += next.value.byteLength;
        if (size > maxBytes) throw new WopiError(413);
        c.enqueue(next.value);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          cleanup();
          c.error(error);
          void reader.cancel().catch(() => undefined);
        }
      }
    },
    async cancel(reason) {
      stopped = true;
      cleanup();
      await reader.cancel(reason);
    },
  });
}
export async function contentVersion(
  storage: StorageProvider,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ version: string; size: number; modifiedAt: Date | null }> {
  const download = await storage.download(path, { signal });
  const reader = boundedStream(download.body, maxBytes, signal).getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      hash.update(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const mtime = download.lastModified?.getTime() ?? 0;
  return {
    version: deriveFileVersion({
      mtimeNs: BigInt(mtime) * 1000000n,
      size: BigInt(size),
      sha256: hash.digest("hex"),
    }),
    size,
    modifiedAt: download.lastModified,
  };
}

/** Validate the complete request on private disk before touching upstream content. */
export async function withStagedUpload<T>(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  consume: (body: ReadableStream<Uint8Array>, size: number) => Promise<T>,
  temporaryRoot = tmpdir(),
): Promise<T> {
  const directory = await mkdtemp(join(temporaryRoot, "fdrive-office-"));
  const path = join(directory, "upload");
  try {
    await pipeline(
      Readable.fromWeb(boundedStream(source, maxBytes, signal)),
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
    if (signal.aborted) throw new WopiError(408);
    const size = (await stat(path)).size;
    const file = createReadStream(path);
    try {
      return await consume(Readable.toWeb(file), size);
    } finally {
      file.destroy();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
