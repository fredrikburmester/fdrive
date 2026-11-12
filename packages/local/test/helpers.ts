import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStorageError, type StorageProvider } from "@fdrive/core";
import { fromBuffer, type ZipFile } from "yauzl";
import { createLocalStorage } from "../src/storage-provider.js";

export interface Fixture {
  /** A fresh temporary folder that stands in for the storage root. */
  readonly root: string;
  /** Alice's home under the root; created by the storage on first use. */
  readonly home: string;
  readonly storage: StorageProvider;
  cleanup(): Promise<void>;
}

export async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fdrive-local-")));
  const home = join(root, "alice");
  return {
    root,
    home,
    storage: createLocalStorage({ home }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** A body that yields `chunks`, then fails when `failWith` is given. */
export function streamOf(chunks: readonly string[], failWith?: Error): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(bytes(chunk));
      if (failWith !== undefined) controller.error(failWith);
      else controller.close();
    },
  });
}

export async function read(storage: StorageProvider, path: string): Promise<string> {
  return new Response((await storage.download(path)).body).text();
}

/** The `StorageError` kind a promise rejects with, `null` when it resolves. */
export async function kindOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isStorageError(error) ? error.kind : `not a StorageError: ${String(error)}`;
  }
}

export interface ZipListing {
  readonly name: string;
  /** 0 stored, 8 deflated. */
  readonly method: number;
}

/** The entries of a zip stream, in order. */
export async function zipEntries(body: ReadableStream<Uint8Array>): Promise<ZipListing[]> {
  const buffer = Buffer.from(await new Response(body).arrayBuffer());
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true }, (error, file) => {
      if (error) reject(error);
      else resolve(file);
    });
  });
  const entries: ZipListing[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: { fileName: string; compressionMethod: number }) => {
      entries.push({ name: entry.fileName, method: entry.compressionMethod });
      zip.readEntry();
    });
    zip.on("end", () => resolve());
    zip.on("error", reject);
    zip.readEntry();
  });
  return entries;
}
