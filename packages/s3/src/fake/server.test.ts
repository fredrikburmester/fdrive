import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createS3Client } from "../client.js";
import { createFakeS3Server, type FakeS3Options } from "./server.js";

const ALICE = { accessKeyId: "alice-key", secretAccessKey: "alice-secret" };
const SIGNED = {
  authorization:
    "AWS4-HMAC-SHA256 Credential=alice-key/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=abc",
};

function build(options: Partial<FakeS3Options> = {}) {
  const server = createFakeS3Server({ keys: [ALICE], ...options });
  const client = createS3Client({
    endpoint: "http://s3.test",
    region: "us-east-1",
    credential: ALICE,
    fetch: server.fetch,
  });
  return { server, client };
}

async function code(response: Response): Promise<string | null> {
  const match = /<Code>([A-Za-z]+)<\/Code>/.exec(await response.text());
  return match === null ? null : (match[1] as string);
}

describe("authentication", () => {
  it("refuses anonymous, malformed and unknown credentials", async () => {
    const { server } = build();
    expect(await code(await server.fetch("http://s3.test/bucket/k"))).toBe("AccessDenied");
    const malformed = await server.fetch("http://s3.test/bucket/k", {
      headers: { authorization: "Bearer nope" },
    });
    expect(malformed.status).toBe(400);
    expect(await code(malformed)).toBe("AuthorizationHeaderMalformed");
    const unknown = await server.fetch("http://s3.test/bucket/k", {
      headers: {
        authorization: SIGNED.authorization.replace("alice-key", "ghost"),
      },
    });
    expect(await code(unknown)).toBe("InvalidAccessKeyId");
    const bad = await server.fetch("http://s3.test/bucket/k", { headers: SIGNED });
    expect(await code(bad)).toBe("SignatureDoesNotMatch");
    const missingHeader = await server.fetch("http://s3.test/bucket/k?uploads", {
      method: "POST",
      headers: {
        authorization: SIGNED.authorization.replace(
          "SignedHeaders=host",
          "SignedHeaders=host;x-gone",
        ),
      },
    });
    expect(await code(missingHeader)).toBe("SignatureDoesNotMatch");
  });

  it("answers a missing bucket before authentication and refuses other origins", async () => {
    const { server } = build();
    expect(await code(await server.fetch("http://s3.test/other/k"))).toBe("NoSuchBucket");
    await expect(server.fetch("http://elsewhere.test/bucket/k")).rejects.toThrow("fake S3 answers");
  });

  it("can skip signature verification and run an interceptor first", async () => {
    const { server } = build({
      verifySignatures: false,
      intercept: (_request, parsed) =>
        parsed.key === "intercepted" ? new Response("mine", { status: 418 }) : null,
    });
    server.put("bucket", "k", "v");
    const ok = await server.fetch("http://s3.test/bucket/k", { headers: SIGNED });
    expect(await ok.text()).toBe("v");
    const mine = await server.fetch("http://s3.test/bucket/intercepted");
    expect(mine.status).toBe(418);
  });
});

describe("bucket-level requests", () => {
  it("answers HEAD, refuses other methods and paginates listings", async () => {
    const { server, client } = build({ verifySignatures: false });
    for (const key of ["a/1", "a/2", "b/1", "c", "d"]) server.put("bucket", key, key);
    expect(
      (await server.fetch("http://s3.test/bucket/", { method: "HEAD", headers: SIGNED })).status,
    ).toBe(200);
    expect(
      await code(await server.fetch("http://s3.test/bucket/", { method: "PUT", headers: SIGNED })),
    ).toBe("MethodNotAllowed");
    const first = await client.send(
      new ListObjectsV2Command({ Bucket: "bucket", Delimiter: "/", MaxKeys: 2 }),
    );
    expect(first.CommonPrefixes?.map((item) => item.Prefix)).toEqual(["a/", "b/"]);
    expect(first.IsTruncated).toBe(true);
    const second = await client.send(
      new ListObjectsV2Command({
        Bucket: "bucket",
        Delimiter: "/",
        MaxKeys: 2,
        ContinuationToken: first.NextContinuationToken,
      }),
    );
    expect(second.Contents?.map((item) => item.Key)).toEqual(["c", "d"]);
    expect(second.IsTruncated).toBe(false);
    const after = await client.send(
      new ListObjectsV2Command({ Bucket: "bucket", StartAfter: "c" }),
    );
    expect(after.Contents?.map((item) => item.Key)).toEqual(["d"]);
  });

  it("deletes in batches, reporting denied keys and echoing deleted ones unless quiet", async () => {
    const { server, client } = build({ keys: [{ ...ALICE, denyPrefixes: ["locked/"] }] });
    server.put("bucket", "a&b", "1");
    server.put("bucket", "locked/x", "2");
    const out = await client.send(
      new DeleteObjectsCommand({
        Bucket: "bucket",
        Delete: { Objects: [{ Key: "a&b" }, { Key: "locked/x" }] },
      }),
    );
    expect(out.Deleted?.map((item) => item.Key)).toEqual(["a&b"]);
    expect(out.Errors?.map((item) => [item.Key, item.Code])).toEqual([
      ["locked/x", "AccessDenied"],
    ]);
    expect(server.objects("bucket").has("locked/x")).toBe(true);
  });
});

describe("objects", () => {
  it("serves ranges, suffix ranges and refuses malformed or unsatisfiable ones", async () => {
    const { server, client } = build();
    server.put("bucket", "f", "0123456789");
    const get = (range: string) =>
      client.send(new GetObjectCommand({ Bucket: "bucket", Key: "f", Range: range }));
    expect(await (await get("bytes=-3")).Body?.transformToString()).toBe("789");
    expect(await (await get("bytes=8-99")).Body?.transformToString()).toBe("89");
    await expect(get("bytes=5-2")).rejects.toMatchObject({ name: "InvalidRange" });
    await expect(get("bytes=-0")).rejects.toMatchObject({ name: "InvalidRange" });
    await expect(get("bytes=-")).rejects.toMatchObject({ name: "InvalidRange" });
    await expect(get("nonsense")).rejects.toMatchObject({ name: "InvalidRange" });
    const { server: open } = build({ verifySignatures: false });
    open.put("bucket", "f", "0123456789");
    const head = await open.fetch("http://s3.test/bucket/f", {
      method: "HEAD",
      headers: { ...SIGNED, range: "bytes=0-1" },
    });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe("bytes 0-1/10");
    expect(await head.text()).toBe("");
  });

  it("stores raw puts and replacement copies without a content type", async () => {
    const { server } = build({ verifySignatures: false });
    const put = await server.fetch("http://s3.test/bucket/raw", {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
      headers: SIGNED,
    });
    expect(put.status).toBe(200);
    expect(server.objects("bucket").get("raw")).toMatchObject({
      contentType: "binary/octet-stream",
    });
    const copy = await server.fetch("http://s3.test/bucket/copied", {
      method: "PUT",
      headers: {
        ...SIGNED,
        "x-amz-copy-source": "/bucket/raw",
        "x-amz-metadata-directive": "REPLACE",
      },
    });
    expect(copy.status).toBe(200);
    expect(server.objects("bucket").get("copied")).toMatchObject({
      contentType: "binary/octet-stream",
    });
    const entities = await server.fetch("http://s3.test/bucket/?delete", {
      method: "POST",
      headers: SIGNED,
      body: "<Delete><Object><Key>it&apos;s &#233; &lt;raw&gt;</Key></Object></Delete>",
    });
    expect(await entities.text()).toContain(
      "<Deleted><Key>it&apos;s é &lt;raw&gt;</Key></Deleted>".replace("&apos;s", "'s"),
    );
  });

  it("honours If-Unmodified-Since and If-None-Match, and records metadata", async () => {
    const { server, client } = build({ now: () => new Date("2026-01-01T00:00:00Z") });
    await client.send(
      new PutObjectCommand({
        Bucket: "bucket",
        Key: "m",
        Body: new Uint8Array([1]),
        Metadata: { mtime: "5" },
      }),
    );
    expect(server.objects("bucket").get("m")).toMatchObject({
      contentType: "application/octet-stream",
      metadata: { mtime: "5" },
    });
    await expect(
      client.send(
        new GetObjectCommand({
          Bucket: "bucket",
          Key: "m",
          IfUnmodifiedSince: new Date("2020-01-01T00:00:00Z"),
        }),
      ),
    ).rejects.toMatchObject({ name: "PreconditionFailed" });
    await expect(
      client.send(
        new PutObjectCommand({ Bucket: "bucket", Key: "m", Body: "x", IfNoneMatch: "*" }),
      ),
    ).rejects.toMatchObject({ name: "PreconditionFailed" });
    const put = await server.fetch("http://s3.test/bucket/n", {
      method: "PUT",
      body: "raw",
      headers: { ...SIGNED, "if-unmodified-since": "garbage" },
    });
    expect(put.status).toBe(403);
  });

  it("copies with either metadata directive and reports missing sources", async () => {
    const { server, client } = build({ keys: [{ ...ALICE, denyPrefixes: ["locked/"] }] });
    server.put("bucket", "src", "content", "text/plain");
    server.put("bucket", "locked/src", "content");
    await client.send(
      new CopyObjectCommand({
        Bucket: "bucket",
        Key: "replaced",
        CopySource: "/bucket/src",
        MetadataDirective: "REPLACE",
        ContentType: "text/html",
        Metadata: { mtime: "9" },
      }),
    );
    expect(server.objects("bucket").get("replaced")).toMatchObject({
      contentType: "text/html",
      metadata: { mtime: "9" },
    });
    await client.send(
      new CopyObjectCommand({ Bucket: "bucket", Key: "kept", CopySource: "bucket/src" }),
    );
    expect(server.objects("bucket").get("kept")).toMatchObject({ contentType: "text/plain" });
    const copy = (source: string) =>
      client.send(new CopyObjectCommand({ Bucket: "bucket", Key: "x", CopySource: source }));
    await expect(copy("/other/src")).rejects.toMatchObject({ name: "NoSuchBucket" });
    await expect(copy("/bucket/missing")).rejects.toMatchObject({ name: "NoSuchKey" });
    await expect(copy("/bucket/locked/src")).rejects.toMatchObject({ name: "AccessDenied" });
  });

  it("refuses unknown methods and unsupported posts", async () => {
    const { server } = build({ verifySignatures: false });
    expect(
      await code(
        await server.fetch("http://s3.test/bucket/k", { method: "PATCH", headers: SIGNED }),
      ),
    ).toBe("MethodNotAllowed");
    expect(
      await code(
        await server.fetch("http://s3.test/bucket/k", { method: "POST", headers: SIGNED }),
      ),
    ).toBe("InvalidRequest");
  });
});

describe("multipart uploads", () => {
  it("assembles parts in the requested order and computes a multipart ETag", async () => {
    const { server, client } = build();
    const created = await client.send(
      new CreateMultipartUploadCommand({ Bucket: "bucket", Key: "mp", ContentType: "text/plain" }),
    );
    const uploadId = created.UploadId as string;
    expect(server.pendingUploads()).toBe(1);
    const part = async (number: number, body: string) =>
      (
        await client.send(
          new UploadPartCommand({
            Bucket: "bucket",
            Key: "mp",
            UploadId: uploadId,
            PartNumber: number,
            Body: body,
          }),
        )
      ).ETag;
    const second = await part(2, "world");
    const first = await part(1, "hello ");
    await expect(
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: "bucket",
          Key: "mp",
          UploadId: uploadId,
          MultipartUpload: { Parts: [{ PartNumber: 3, ETag: '"x"' }] },
        }),
      ),
    ).rejects.toMatchObject({ name: "InvalidPart" });
    const done = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: "bucket",
        Key: "mp",
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: first },
            { PartNumber: 2, ETag: second },
          ],
        },
      }),
    );
    expect(done.ETag?.endsWith('-2"')).toBe(true);
    expect(new TextDecoder().decode(server.objects("bucket").get("mp")?.bytes)).toBe("hello world");
    expect(server.pendingUploads()).toBe(0);
  });

  it("reports an unknown upload for parts, completion and abort", async () => {
    const { client } = build();
    const input = { Bucket: "bucket", Key: "mp", UploadId: "nope" };
    await expect(
      client.send(new UploadPartCommand({ ...input, PartNumber: 1, Body: "x" })),
    ).rejects.toMatchObject({ name: "NoSuchUpload" });
    await expect(
      client.send(new CompleteMultipartUploadCommand({ ...input, MultipartUpload: { Parts: [] } })),
    ).rejects.toMatchObject({ name: "NoSuchUpload" });
    await expect(client.send(new AbortMultipartUploadCommand(input))).rejects.toMatchObject({
      name: "NoSuchUpload",
    });
    const created = await client.send(
      new CreateMultipartUploadCommand({ Bucket: "bucket", Key: "mp" }),
    );
    await client.send(new AbortMultipartUploadCommand({ ...input, UploadId: created.UploadId }));
  });
});

describe("seeding and inspection", () => {
  it("seeds objects, refuses unknown buckets and unescapes XML entities in keys", async () => {
    const server = createFakeS3Server({
      keys: [ALICE],
      buckets: ["one"],
      objects: { "one/a b/<&>.txt": "x" },
    });
    expect(server.objects("one").has("a b/<&>.txt")).toBe(true);
    expect(() => server.objects("two")).toThrow("unknown bucket two");
    expect(() => server.put("two", "k", "v")).toThrow("unknown bucket two");
    expect(() => createFakeS3Server({ keys: [], objects: { "nope/k": "v" } })).toThrow(
      "unknown bucket in nope/k",
    );
    const client = createS3Client({
      endpoint: "http://s3.test",
      region: "us-east-1",
      credential: ALICE,
      fetch: server.fetch,
    });
    const listed = await client.send(new ListObjectsV2Command({ Bucket: "one" }));
    expect(listed.Contents?.[0]?.Key).toBe("a b/<&>.txt");
    await client.send(
      new DeleteObjectsCommand({
        Bucket: "one",
        Delete: { Objects: [{ Key: "a b/<&>.txt" }, { Key: "it's &#233;" }], Quiet: true },
      }),
    );
    expect(server.objects("one").size).toBe(0);
  });
});
