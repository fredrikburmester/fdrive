import {
  createRecycleFolderTrash,
  isStorageError,
  type StorageProvider,
  withMoveToTrash,
} from "@fdrive/core";
import {
  describeStorageProvider,
  type MinioContainer,
  type MinioKey,
  startMinio,
} from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Client } from "../../src/client.js";
import { s3Module } from "../../src/module.js";
import { probeConnection } from "../../src/probe.js";
import { createS3StorageProvider } from "../../src/storage-provider.js";

function text(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

async function kindOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isStorageError(error) ? error.kind : `not a StorageError: ${String(error)}`;
  }
}

function storageFor(container: MinioContainer, key: MinioKey, prefix = ""): StorageProvider {
  const client = createS3Client({
    endpoint: container.endpoint,
    region: "us-east-1",
    credential: key,
    fetch: globalThis.fetch,
  });
  return createS3StorageProvider({ client: async () => client, bucket: container.bucket, prefix });
}

/**
 * The provider-neutral behavioural contract against a real MinIO, plus the
 * S3-specific behaviour the fake models: signed listings, refused writes,
 * multipart uploads, range reads and the API's move-based Trash.
 */
describe("S3 provider against MinIO", () => {
  let container: MinioContainer;

  beforeAll(async () => {
    container = await startMinio();
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  }, 180_000);

  describeStorageProvider(
    "MinIO container",
    () => ({ storage: storageFor(container, container.writer) }),
    {
      overwritesOnMove: true,
    },
  );

  describeStorageProvider(
    "MinIO container under a prefix",
    () => ({ storage: storageFor(container, container.writer, "team/drive") }),
    { overwritesOnMove: true },
  );

  it("probes the bucket and authenticates through the module", async () => {
    expect(await probeConnection(container.baseUrl, { fetch: globalThis.fetch })).toEqual({
      ok: true,
      detail: `S3 bucket ${container.bucket} is reachable and requires a login`,
    });
    // MinIO does not tell an anonymous caller whether a bucket exists; the
    // signed check in `authenticate` reports the missing bucket instead.
    expect(
      (await probeConnection(`${container.endpoint}/missing-bucket`, { fetch: globalThis.fetch }))
        .ok,
    ).toBe(true);
    const instance = { id: "minio", baseUrl: `${container.baseUrl}/team`, config: {} };
    const ctx = { fetch: globalThis.fetch };
    expect(
      await s3Module.authenticate(
        instance,
        { username: container.writer.accessKeyId, password: container.writer.secretAccessKey },
        ctx,
      ),
    ).toEqual({ externalUsername: container.writer.accessKeyId });
    expect(
      await kindOf(
        s3Module.authenticate(
          instance,
          { username: container.writer.accessKeyId, password: "wrong" },
          ctx,
        ),
      ),
    ).toBe("unauthorized");
    expect(
      await kindOf(s3Module.authenticate(instance, { username: "nobody", password: "x" }, ctx)),
    ).toBe("unauthorized");
    expect(
      await kindOf(
        s3Module.authenticate(
          { ...instance, baseUrl: `${container.endpoint}/missing-bucket` },
          { username: container.writer.accessKeyId, password: container.writer.secretAccessKey },
          ctx,
        ),
      ),
    ).toBe("upstream_unavailable");
  });

  it("maps a write the server refuses to forbidden", async () => {
    const writer = storageFor(container, container.writer);
    await writer.upload("/shared/readme.txt", new TextEncoder().encode("read me"));
    const reader = storageFor(container, container.reader);
    expect(await text((await reader.download("/shared/readme.txt")).body)).toBe("read me");
    expect(await kindOf(reader.mkdir("/denied"))).toBe("forbidden");
    expect(await kindOf(reader.upload("/denied.txt", new TextEncoder().encode("x")))).toBe(
      "forbidden",
    );
    // MinIO's built-in `readonly` policy grants GetObject without ListBucket.
    expect(await kindOf(reader.list("/shared"))).toBe("forbidden");
    await writer.deleteDir("/shared");
  });

  it("streams a multipart upload, keeps the given mtime and serves ranges", async () => {
    const writer = storageFor(container, container.writer);
    const path = `/multipart-${Date.now().toString(36)}.bin`;
    const bytes = new Uint8Array(17 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index += 4096) bytes[index] = index % 251;
    const at = new Date("2020-01-02T03:04:05Z");
    await writer.upload(path, new Blob([bytes]).stream(), { modifiedAt: at });
    const stat = await writer.statFile(path);
    expect(stat).toMatchObject({ size: bytes.length, contentType: "application/octet-stream" });
    expect(stat.modifiedAt?.getTime()).toBe(at.getTime());
    const range = await writer.download(path, { range: { start: 4096, end: 4098 } });
    expect(range.status).toBe(206);
    expect(range.contentRange).toBe(`bytes 4096-4098/${bytes.length}`);
    expect(new Uint8Array(await new Response(range.body).arrayBuffer())).toEqual(
      new Uint8Array([4096 % 251, 0, 0]),
    );
    const stale = await writer.download(path, { range: { start: 0, end: 1 }, ifRange: '"nope"' });
    expect(stale.status).toBe(200);
    expect((await new Response(stale.body).arrayBuffer()).byteLength).toBe(bytes.length);
    await writer.deleteFile(path);
  });

  it("moves deletes into a recycle folder, restores them and purges them (the API's Trash for S3)", async () => {
    const storage = storageFor(container, container.writer);
    const trashPath = `/.s3-trash-${Date.now().toString(36)}`;
    const wrapped = withMoveToTrash({ storage, trashPath, clock: () => new Date() });
    const trash = createRecycleFolderTrash({ storage: wrapped, trashPath, layout: "move" });
    const original = `/s3-generic/2026/Å %20/${"x".repeat(200)}`;
    await storage.mkdir(original, { parents: true });
    await storage.upload(`${original}/keep.txt`, new TextEncoder().encode("kept"));
    await wrapped.deleteDir(original);
    expect(await kindOf(storage.stat(original))).toBe("not_found");
    const item = (await trash.list()).entries.find((entry) => entry.originalPath === original);
    expect(item).toBeDefined();
    expect(await trash.restore(item?.id ?? "missing")).toMatchObject({
      path: original,
      kind: "dir",
    });
    expect(await text((await storage.download(`${original}/keep.txt`)).body)).toBe("kept");

    await wrapped.deleteFile(`${original}/keep.txt`);
    const file = (await trash.list()).entries.find(
      (entry) => entry.originalPath === `${original}/keep.txt`,
    );
    expect(file).toMatchObject({ name: "keep.txt", size: 4 });
    await trash.purge([file?.id ?? "missing"]);
    expect((await trash.list()).entries).toEqual([]);

    await wrapped.deleteDir(original);
    expect((await trash.list()).entries).toHaveLength(1);
    await trash.empty();
    expect((await trash.list()).entries).toEqual([]);
    expect(await kindOf(storage.stat(original))).toBe("not_found");
    await storage.deleteDir("/s3-generic");
    await storage.deleteDir(trashPath);
  });
});
