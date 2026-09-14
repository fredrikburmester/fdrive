import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import type { BlobSource } from "./types.js";

export async function digest(stream: Readable): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}
export function limitBytes(max: number): Transform {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > max ? Error("Backup size limit exceeded") : null, chunk);
    },
  });
}
export async function syncFile(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function readBounded(stream: Readable, max = 4 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) {
      stream.destroy();
      throw Error("Backup entry exceeds limit");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function localBlobs(
  root: string,
  kind: BlobSource["kind"],
  maxEntries = 100_000,
): Promise<BlobSource[]> {
  const results: BlobSource[] = [];
  async function walk(relative: string): Promise<void> {
    const directory = join(root, relative);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Backup source is not a directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw Error("Symbolic links are not backup sources");
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        if (results.length >= maxEntries) throw Error("Too many backup source files");
        const path = join(root, name);
        const initial = await lstat(path);
        results.push({
          kind,
          path: name,
          size: initial.size,
          async open() {
            // O_NOFOLLOW rejects path replacement with a symlink. Check the opened inode,
            // then keep that descriptor until streaming completes.
            const { constants } = await import("node:fs");
            const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            const current = await file.stat();
            if (
              !current.isFile() ||
              current.ino !== initial.ino ||
              (kind === "logs"
                ? current.size < initial.size
                : current.size !== initial.size || current.mtimeMs !== initial.mtimeMs)
            ) {
              await file.close();
              throw Error("Backup source changed during checkpoint");
            }
            return Readable.from(
              (async function* () {
                try {
                  // Diagnostic logs may append. Snapshot only the prefix that existed
                  // at the checkpoint; all other files must stay byte-stable.
                  const stream = file.createReadStream({
                    autoClose: false,
                    ...(initial.size > 0 ? { start: 0, end: initial.size - 1 } : {}),
                  });
                  if (initial.size > 0) for await (const chunk of stream) yield chunk;
                  const after = await file.stat();
                  if (
                    after.ino !== initial.ino ||
                    (kind === "logs"
                      ? after.size < initial.size
                      : after.size !== initial.size ||
                        after.mtimeMs !== initial.mtimeMs ||
                        after.ctimeMs !== initial.ctimeMs)
                  )
                    throw Error("Backup source changed while reading");
                } finally {
                  await file.close();
                }
              })(),
            );
          },
        });
      } else throw Error("Unsupported backup source file");
    }
  }
  await walk("");
  return results;
}
export function fileStream(path: string): Readable {
  return createReadStream(path);
}
export function bytesStream(bytes: Uint8Array): Readable {
  return Readable.from([bytes]);
}

/** Observe cleanup failures without replacing the primary operation error. */
export function ignoreCleanupError(): void {}
