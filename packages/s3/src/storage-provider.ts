import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { EntryStat, FileEntry, StorageProvider } from "@fdrive/core";
import {
  baseName,
  extensionOf,
  isWithin,
  makeEntry,
  mimeFromExtension,
  normalizePath,
  parentPath,
  StorageError,
  splitSegments,
} from "@fdrive/core";
import { kindForSdkError, toStorageError } from "./errors.js";
import { childName, copySource, dirKey, fileKey } from "./keys.js";

export interface S3StorageProviderDeps {
  /**
   * The client for each call. The API's session unseals the credential on
   * demand; the module rebuilds the client when the key pair changes, so a
   * rotated secret takes effect on the next request.
   */
  readonly client: () => Promise<S3Client>;
  readonly bucket: string;
  /** Key prefix without leading or trailing slash; `""` for the bucket root. */
  readonly prefix: string;
  /** Keys one directory operation may touch before refusing; defaults to `MAX_DIRECTORY_KEYS`. */
  readonly maxDirectoryKeys?: number;
}

/** `StorageProvider["download"]`'s options, spelled out for the adapter's own helpers. */
export interface S3DownloadOpts {
  range?: { start: number; end?: number };
  ifRange?: string;
  signal?: AbortSignal;
}

const LIST_PAGE_SIZE = 1000;
/** Keys one directory operation will list, copy or delete before refusing. */
export const MAX_DIRECTORY_KEYS = 100_000;
const DELETE_BATCH_SIZE = 1000;
/** `CopyObject` refuses larger sources; a multipart copy is not implemented. */
export const MAX_COPY_BYTES = 5 * 1024 * 1024 * 1024;
/**
 * Multipart part size and parts in flight. `Upload` buffers up to
 * `PART_SIZE * UPLOAD_QUEUE_SIZE` (32 MiB) per streaming upload in the API
 * process, and each part must reach the bucket within the request timeout;
 * both match the backup destination. 10 000 parts bound a file at 80 GiB.
 */
const PART_SIZE = 8 * 1024 * 1024;
const UPLOAD_QUEUE_SIZE = 4;
const COPY_CONCURRENCY = 4;
/** User metadata key rclone and others use for a client-supplied mtime (unix seconds). */
const MTIME_METADATA_KEY = "mtime";
const DIRECTORY_CONTENT_TYPE = "application/x-directory";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

interface ObjectHead {
  readonly size: number;
  readonly modifiedAt: Date | null;
  readonly contentType: string | null;
}

interface ListedKey {
  readonly key: string;
  readonly size: number;
  readonly modifiedAt: Date | null;
}

interface ListedPage {
  readonly files: ListedKey[];
  readonly prefixes: string[];
}

async function run<T>(fn: () => Promise<T>, path?: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toStorageError(error, path);
  }
}

function isNotFound(error: unknown): boolean {
  return kindForSdkError(error) === "not_found";
}

function tooManyKeys(path: string, bound: number): StorageError {
  return new StorageError(
    "internal",
    `folder ${path} has more than ${bound} objects; fdrive cannot move, copy or delete it as a whole`,
  );
}

function tooManyEntries(path: string, bound: number): StorageError {
  return new StorageError(
    "internal",
    `folder ${path} has more than ${bound} entries; fdrive cannot list it`,
  );
}

function notFound(path: string): StorageError {
  return new StorageError("not_found", `not found: ${path}`);
}

function modifiedAtFrom(
  metadata: Record<string, string> | undefined,
  lastModified: Date | undefined,
): Date | null {
  const stored = metadata?.[MTIME_METADATA_KEY];
  if (stored !== undefined) {
    const seconds = Number.parseFloat(stored);
    if (Number.isFinite(seconds)) return new Date(Math.round(seconds * 1000));
  }
  return lastModified ?? null;
}

function contentTypeFor(path: string): string {
  return mimeFromExtension(extensionOf(baseName(path))) ?? DEFAULT_CONTENT_TYPE;
}

function metadataFor(modifiedAt: Date): Record<string, string> {
  return { [MTIME_METADATA_KEY]: (modifiedAt.getTime() / 1000).toString() };
}

/** The path of a file operation; the root is never a file. */
function filePath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") throw new StorageError("bad_request", "the root is not a file");
  return normalized;
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Builds a `StorageProvider` over one bucket and prefix. Directories are
 * key prefixes: a directory exists when an empty marker object sits at
 * `dir/` or any key starts with it, and `mkdir` writes the marker. Moves are
 * copy-then-delete per object; `overwrite: false` is a pre-check and racy.
 * Returns own-property methods so the API's Trash wrappers can spread the
 * object.
 */
export function createS3StorageProvider(deps: S3StorageProviderDeps): StorageProvider {
  const { bucket, prefix } = deps;
  const maxKeys = deps.maxDirectoryKeys ?? MAX_DIRECTORY_KEYS;

  async function head(client: S3Client, key: string): Promise<ObjectHead | null> {
    try {
      const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        size: out.ContentLength ?? 0,
        modifiedAt: modifiedAtFrom(out.Metadata, out.LastModified),
        contentType: out.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function page(
    client: S3Client,
    keyPrefix: string,
    options: { delimiter?: boolean; token?: string | undefined; maxKeys?: number },
  ): Promise<ListedPage & { next: string | undefined }> {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ...(keyPrefix.length === 0 ? {} : { Prefix: keyPrefix }),
        ...(options.delimiter === true ? { Delimiter: "/" } : {}),
        ...(options.token === undefined ? {} : { ContinuationToken: options.token }),
        MaxKeys: options.maxKeys ?? LIST_PAGE_SIZE,
      }),
    );
    const files: ListedKey[] = [];
    for (const item of out.Contents ?? []) {
      if (typeof item.Key !== "string" || !item.Key.startsWith(keyPrefix)) continue;
      files.push({ key: item.Key, size: item.Size ?? 0, modifiedAt: item.LastModified ?? null });
    }
    const prefixes: string[] = [];
    for (const item of out.CommonPrefixes ?? []) {
      if (typeof item.Prefix === "string" && item.Prefix.startsWith(keyPrefix)) {
        prefixes.push(item.Prefix);
      }
    }
    const next = out.IsTruncated === true ? out.NextContinuationToken : undefined;
    return { files, prefixes, next };
  }

  /** Every key under `keyPrefix`, the marker included, bounded by `MAX_DIRECTORY_KEYS`. */
  async function collectKeys(
    client: S3Client,
    keyPrefix: string,
    path: string,
  ): Promise<ListedKey[]> {
    const keys: ListedKey[] = [];
    let token: string | undefined;
    do {
      const result = await page(client, keyPrefix, { token });
      keys.push(...result.files);
      if (keys.length > maxKeys) throw tooManyKeys(path, maxKeys);
      token = result.next;
    } while (token !== undefined);
    return keys;
  }

  async function dirExists(client: S3Client, keyPrefix: string): Promise<boolean> {
    const result = await page(client, keyPrefix, { maxKeys: 1 });
    return result.files.length > 0;
  }

  /** `bad_request` for a file, `not_found` for nothing, after a directory turned out empty. */
  async function missingDirectory(client: S3Client, path: string): Promise<StorageError> {
    const existing = await head(client, fileKey(prefix, path));
    return existing === null
      ? notFound(path)
      : new StorageError("bad_request", `not a directory: ${path}`);
  }

  async function stat(client: S3Client, path: string): Promise<EntryStat> {
    if (path === "/") return { kind: "dir", size: 0, modifiedAt: null, contentType: null };
    const file = await head(client, fileKey(prefix, path));
    if (file !== null) return { kind: "file", ...file };
    if (await dirExists(client, dirKey(prefix, path))) {
      return { kind: "dir", size: 0, modifiedAt: null, contentType: null };
    }
    throw notFound(path);
  }

  async function statOrNull(client: S3Client, path: string): Promise<EntryStat | null> {
    try {
      return await stat(client, path);
    } catch (error) {
      if (toStorageError(error).kind === "not_found") return null;
      throw error;
    }
  }

  async function copyObject(client: S3Client, from: ListedKey, toKey: string): Promise<void> {
    if (from.size > MAX_COPY_BYTES) {
      throw new StorageError(
        "payload_too_large",
        `objects over 5 GiB cannot be copied or moved through fdrive: ${from.key}`,
      );
    }
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: copySource(bucket, from.key),
        Key: toKey,
        MetadataDirective: "COPY",
      }),
    );
  }

  async function deleteKeys(client: S3Client, keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
      const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
      const out = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
        }),
      );
      const failure = out.Errors?.[0];
      if (failure !== undefined) {
        throw new StorageError(
          failure.Code === "AccessDenied" ? "forbidden" : "internal",
          `S3 refused to delete ${failure.Key ?? "an object"}: ${failure.Code ?? "unknown error"}`,
        );
      }
    }
  }

  /** Copies, then optionally deletes, every object of a file or directory. */
  async function transfer(
    path: string,
    target: string,
    opts: { overwrite?: boolean } | undefined,
    removeSource: boolean,
  ): Promise<void> {
    const source = normalizePath(path);
    const destination = normalizePath(target);
    if (source === "/" || destination === "/") {
      throw new StorageError("bad_request", "the root cannot be moved or copied");
    }
    if (source === destination || isWithin(source, destination)) {
      throw new StorageError(
        "bad_request",
        `cannot ${removeSource ? "move" : "copy"} ${source} into itself`,
      );
    }
    const client = await deps.client();
    await run(async () => {
      const existing = await stat(client, source);
      const current = await statOrNull(client, destination);
      if (current !== null && opts?.overwrite === false) {
        throw new StorageError("conflict", `already exists: ${destination}`);
      }
      const targetDir = dirKey(prefix, destination);
      // An existing target is replaced, as the port promises and as a WebDAV
      // server does: a folder's objects go first so none survive under the new
      // one, and a file under a folder's name goes too. A file target is
      // overwritten by the copy itself.
      if (current?.kind === "dir") {
        const stale = await collectKeys(client, targetDir, destination);
        await deleteKeys(
          client,
          stale.map((item) => item.key),
        );
      } else if (current?.kind === "file" && existing.kind === "dir") {
        await deleteKeys(client, [fileKey(prefix, destination)]);
      }
      if (existing.kind === "file") {
        const from = { key: fileKey(prefix, source), size: existing.size, modifiedAt: null };
        await copyObject(client, from, fileKey(prefix, destination));
        if (removeSource) await deleteKeys(client, [from.key]);
        return;
      }
      const sourceDir = dirKey(prefix, source);
      const keys = await collectKeys(client, sourceDir, source);
      await mapLimit(keys, COPY_CONCURRENCY, (from) =>
        copyObject(client, from, `${targetDir}${from.key.slice(sourceDir.length)}`),
      );
      if (removeSource) {
        await deleteKeys(
          client,
          keys.map((item) => item.key),
        );
      }
    }, source);
  }

  return {
    async list(path: string): Promise<FileEntry[]> {
      const normalized = normalizePath(path);
      const client = await deps.client();
      return run(async () => {
        const keyPrefix = dirKey(prefix, normalized);
        const files: ListedKey[] = [];
        const prefixes: string[] = [];
        let token: string | undefined;
        do {
          const result = await page(client, keyPrefix, { delimiter: true, token });
          files.push(...result.files);
          prefixes.push(...result.prefixes);
          if (files.length + prefixes.length > maxKeys) throw tooManyEntries(normalized, maxKeys);
          token = result.next;
        } while (token !== undefined);
        if (normalized !== "/" && files.length === 0 && prefixes.length === 0) {
          throw await missingDirectory(client, normalized);
        }
        const entries = new Map<string, FileEntry>();
        for (const item of prefixes) {
          const name = childName(keyPrefix, item);
          if (name === null) continue;
          entries.set(
            name,
            makeEntry(normalized, { name, kind: "dir", size: 0, modifiedAt: new Date(0) }),
          );
        }
        for (const item of files) {
          const name = childName(keyPrefix, item.key);
          // The directory's own marker and any name that is also a
          // directory are skipped; a folder wins over a same-named object.
          if (name === null || item.key.endsWith("/") || entries.has(name)) continue;
          entries.set(
            name,
            makeEntry(normalized, {
              name,
              kind: "file",
              size: item.size,
              modifiedAt: item.modifiedAt ?? new Date(0),
            }),
          );
        }
        return [...entries.values()];
      }, normalized);
    },

    async stat(path: string): Promise<EntryStat> {
      const normalized = normalizePath(path);
      const client = await deps.client();
      return run(() => stat(client, normalized), normalized);
    },

    async statFile(path: string) {
      const normalized = normalizePath(path);
      const client = await deps.client();
      return run(async () => {
        const result = await stat(client, normalized);
        if (result.kind === "dir") {
          throw new StorageError("bad_request", `not a file: ${normalized}`);
        }
        return {
          size: result.size,
          modifiedAt: result.modifiedAt,
          contentType: result.contentType,
        };
      }, normalized);
    },

    async probeDirectoryRead(path: string): Promise<void> {
      const normalized = normalizePath(path);
      const client = await deps.client();
      await run(async () => {
        if (normalized === "/") {
          await page(client, dirKey(prefix, normalized), { maxKeys: 1 });
          return;
        }
        if (!(await dirExists(client, dirKey(prefix, normalized)))) {
          throw await missingDirectory(client, normalized);
        }
      }, normalized);
    },

    async download(path: string, opts?: S3DownloadOpts) {
      const normalized = filePath(path);
      const client = await deps.client();
      const key = fileKey(prefix, normalized);
      return run(async () => {
        const range = opts?.range;
        const rangeHeader =
          range === undefined
            ? undefined
            : `bytes=${range.start}-${range.end === undefined ? "" : range.end}`;
        // S3 has no `If-Range`: the validator becomes `If-Match` or
        // `If-Unmodified-Since` on the ranged request, and a 412 answer is
        // retried once as an unconditional full read, which is what
        // `If-Range` promises.
        let conditions: { IfMatch?: string; IfUnmodifiedSince?: Date } = {};
        let ranged = rangeHeader;
        if (opts?.ifRange !== undefined && rangeHeader !== undefined) {
          if (/^(W\/)?"/.test(opts.ifRange)) {
            conditions = { IfMatch: opts.ifRange.replace(/^W\//, "") };
          } else {
            const since = new Date(opts.ifRange);
            if (Number.isNaN(since.getTime())) ranged = undefined;
            else conditions = { IfUnmodifiedSince: since };
          }
        }
        const send = (withRange: boolean) =>
          client.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: key,
              ...(withRange && ranged !== undefined ? { Range: ranged, ...conditions } : {}),
            }),
            opts?.signal === undefined ? {} : { abortSignal: opts.signal },
          );
        let out: Awaited<ReturnType<typeof send>>;
        try {
          out = await send(true);
        } catch (error) {
          if (kindForSdkError(error) !== "conflict" || Object.keys(conditions).length === 0) {
            throw error;
          }
          out = await send(false);
        }
        if (out.Body === undefined) {
          throw new StorageError("internal", `S3 returned no body for ${normalized}`);
        }
        return {
          status: out.ContentRange === undefined ? (200 as const) : (206 as const),
          body: out.Body.transformToWebStream(),
          contentLength: out.ContentLength ?? null,
          contentRange: out.ContentRange ?? null,
          contentType: out.ContentType ?? null,
          lastModified: modifiedAtFrom(out.Metadata, out.LastModified),
        };
      }, normalized);
    },

    async upload(path, body, opts) {
      const normalized = filePath(path);
      const client = await deps.client();
      const key = fileKey(prefix, normalized);
      await run(async () => {
        if (opts?.overwrite === false && (await head(client, key)) !== null) {
          throw new StorageError("conflict", `already exists: ${normalized}`);
        }
        const params = {
          Bucket: bucket,
          Key: key,
          ContentType: contentTypeFor(normalized),
          ...(opts?.modifiedAt === undefined ? {} : { Metadata: metadataFor(opts.modifiedAt) }),
        };
        if (body instanceof Uint8Array) {
          await client.send(
            new PutObjectCommand({ ...params, Body: body, ContentLength: body.byteLength }),
            opts?.signal === undefined ? {} : { abortSignal: opts.signal },
          );
          return;
        }
        const abortController = new AbortController();
        const upload = new Upload({
          client,
          params: { ...params, Body: body },
          partSize: PART_SIZE,
          queueSize: UPLOAD_QUEUE_SIZE,
          leavePartsOnError: false,
          abortController,
        });
        const onAbort = () => abortController.abort();
        if (opts?.signal?.aborted === true) onAbort();
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          await upload.done();
        } finally {
          opts?.signal?.removeEventListener("abort", onAbort);
        }
      }, normalized);
    },

    async mkdir(path, opts) {
      const normalized = normalizePath(path);
      if (normalized === "/") {
        if (opts?.parents === true) return;
        throw new StorageError("conflict", "the root already exists");
      }
      const client = await deps.client();
      await run(async () => {
        // With parents, every missing ancestor gets its own marker, so a
        // folder created for a deeper one keeps existing after that one is
        // removed; the Trash root relies on this. Without parents, the parent
        // must already exist (`not_found` otherwise, as WebDAV answers) and an
        // existing folder is a conflict. A file at any level always is.
        const targets =
          opts?.parents === true
            ? splitSegments(normalized).map(
                (_, index, all) => `/${all.slice(0, index + 1).join("/")}`,
              )
            : [normalized];
        for (const target of targets) {
          if ((await head(client, fileKey(prefix, target))) !== null) {
            throw new StorageError("conflict", `a file exists at ${target}`);
          }
        }
        const key = dirKey(prefix, normalized);
        if (opts?.parents !== true) {
          if (await dirExists(client, key)) {
            throw new StorageError("conflict", `already exists: ${normalized}`);
          }
          const parent = parentPath(normalized);
          if (parent !== "/" && !(await dirExists(client, dirKey(prefix, parent)))) {
            throw await missingDirectory(client, parent);
          }
        }
        for (const target of targets) {
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: dirKey(prefix, target),
              Body: new Uint8Array(0),
              ContentLength: 0,
              ContentType: DIRECTORY_CONTENT_TYPE,
            }),
          );
        }
      }, normalized);
    },

    move: (path, target, opts) => transfer(path, target, opts, true),

    copy: (path, target, opts) => transfer(path, target, opts, false),

    async deleteFile(path: string) {
      const normalized = filePath(path);
      const client = await deps.client();
      await run(async () => {
        const key = fileKey(prefix, normalized);
        if ((await head(client, key)) === null) {
          if (await dirExists(client, dirKey(prefix, normalized))) {
            throw new StorageError("bad_request", `not a file: ${normalized}`);
          }
          throw notFound(normalized);
        }
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      }, normalized);
    },

    async deleteDir(path: string) {
      const normalized = normalizePath(path);
      if (normalized === "/") {
        throw new StorageError("bad_request", "the root cannot be deleted");
      }
      const client = await deps.client();
      await run(async () => {
        const keys = await collectKeys(client, dirKey(prefix, normalized), normalized);
        if (keys.length === 0) throw await missingDirectory(client, normalized);
        await deleteKeys(
          client,
          keys.map((item) => item.key),
        );
      }, normalized);
    },
  };
}
