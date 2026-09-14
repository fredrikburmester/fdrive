import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAbortSignal, Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { isStorageError, type StorageProvider } from "@fdrive/core";
import { digest, fileStream, readBounded } from "./streams.js";
import type { BackupDestination } from "./types.js";

export function destinationKey(prefix: string, key: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key)) throw Error("Invalid backup object name");
  if (
    prefix.includes("\\") ||
    prefix.includes("\0") ||
    prefix.split("/").some((part) => part === ".." || part === ".")
  )
    throw Error("Invalid backup prefix");
  return `${prefix.replace(/^\/+|\/+$/g, "")}/${key}`;
}
export function s3Destination(config: {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}): BackupDestination {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.pathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const key = (name: string) => destinationKey(config.prefix, name);
  return {
    async information(name) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key(name) }),
        );
        const versioning = await client
          .send(new GetBucketVersioningCommand({ Bucket: config.bucket }))
          .then((value) => value.Status ?? "disabled")
          .catch(() => "unknown");
        return {
          ...(result.VersionId ? { versionId: result.VersionId } : {}),
          ...(result.ObjectLockRetainUntilDate
            ? { retentionUntil: result.ObjectLockRetainUntilDate.toISOString() }
            : {}),
          versioning,
        };
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
        )
          return null;
        throw error;
      }
    },
    async put(name, file, signal) {
      const upload = new Upload({
        client,
        params: {
          Bucket: config.bucket,
          Key: key(name),
          Body: createReadStream(file),
          ContentLength: (await stat(file)).size,
          ContentType: "application/octet-stream",
        },
        queueSize: 2,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
      });
      const abort = () => {
        void upload.abort();
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        signal?.throwIfAborted();
        const result = await upload.done();
        return result.VersionId ? { versionId: result.VersionId } : {};
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    async get(name, versionId) {
      const result = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key(name),
          ...(versionId ? { VersionId: versionId } : {}),
        }),
      );
      if (!result.Body) throw Error("Backup object has no body");
      return Readable.fromWeb(result.Body.transformToWebStream());
    },
    async list() {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: `${config.prefix.replace(/^\/+|\/+$/g, "")}/`,
            ...(cursor ? { ContinuationToken: cursor } : {}),
          }),
        );
        for (const object of page.Contents ?? [])
          if (object.Key) {
            const name = object.Key.slice(key("a").length - 1);
            if (!name.includes("/")) names.push(name);
          }
        if (names.length > 100_000) throw Error("Backup catalog limit exceeded");
        cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (cursor);
      return names;
    },
    async remove(name, versionId) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: key(name),
          ...(versionId ? { VersionId: versionId } : {}),
        }),
      );
    },
  };
}
export function providerDestination(storage: StorageProvider, prefix: string): BackupDestination {
  const path = (name: string) => `/${destinationKey(prefix, name)}`;
  return {
    async information(name) {
      try {
        await storage.statFile(path(name));
        return {};
      } catch (error) {
        if (isStorageError(error) && error.kind === "not_found") return null;
        throw error;
      }
    },
    async put(name, file, signal) {
      const bytes = (await stat(file)).size;
      await storage.upload(
        path(name),
        Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
        { overwrite: false, contentLength: bytes, ...(signal ? { signal } : {}) },
      );
      return {};
    },
    async get(name) {
      return Readable.fromWeb(
        (await storage.download(path(name)))
          .body as import("node:stream/web").ReadableStream<Uint8Array>,
      );
    },
    async list() {
      return (await storage.list(`/${prefix.replace(/^\/+|\/+$/g, "")}`))
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.name);
    },
    async remove(name) {
      await storage.deleteFile(path(name));
    },
  };
}
export async function verifyDelivery(
  destination: BackupDestination,
  key: string,
  file: string,
  signal?: AbortSignal,
): Promise<{ versionId?: string }> {
  const cancellable = (stream: Readable) => (signal ? addAbortSignal(signal, stream) : stream);
  const expected = await digest(cancellable(fileStream(file)));
  const existing = await destination.information(key);
  if (existing) {
    const found = await digest(cancellable(await destination.get(key, existing.versionId)));
    if (found.sha256 === expected.sha256 && found.bytes === expected.bytes) return existing;
    // Only a caller-generated, uncommitted UUID key reaches this path. Never replace
    // a completed snapshot with a new capture.
    await destination.remove(key, existing.versionId);
  }
  signal?.throwIfAborted();
  const written = await destination.put(key, file, signal);
  const readback = cancellable(await destination.get(key, written.versionId));
  const actual = await digest(readback);
  if (expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes)
    throw Error("Backup destination readback failed");
  return written;
}
export interface ProbeResult {
  /** A probe object the destination kept under retention; the owner is shown its deadline. */
  retained: { name: string; retentionUntil: string } | null;
}
export async function probeDestination(destination: BackupDestination): Promise<ProbeResult> {
  const directory = await mkdtemp(join(tmpdir(), "fdrive-backup-probe-"));
  const name = `probe-${randomUUID()}`;
  try {
    const file = join(directory, "probe");
    const bytes = randomUUID();
    await writeFile(file, bytes, { mode: 0o600 });
    const { versionId } = await destination.put(name, file);
    let failure: unknown;
    try {
      if ((await readBounded(await destination.get(name, versionId))).toString() !== bytes)
        throw Error("Backup destination probe failed");
    } catch (error) {
      failure = error;
    }
    const retained = await removeProbe(destination, name, versionId);
    if (failure) throw failure;
    return { retained };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function removeProbe(
  destination: BackupDestination,
  name: string,
  versionId: string | undefined,
): Promise<ProbeResult["retained"]> {
  try {
    await destination.remove(name, versionId);
    return null;
  } catch (error) {
    // Bucket-default Object Lock makes every new object undeletable until its deadline. Never
    // request a bypass: accept the retained probe only when the destination itself reports
    // retention for it, and report its name and deadline to the owner.
    const information = await destination.information(name).catch(() => null);
    if (!information?.retentionUntil) throw error;
    return { name, retentionUntil: information.retentionUntil };
  }
}
