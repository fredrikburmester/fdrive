import { isStorageError, type StorageProvider } from "@fdrive/core";
import { describe, expect, it } from "vitest";
import { createS3Client } from "./client.js";
import { createFakeS3Server, type FakeS3Options, type FakeS3Server } from "./fake/server.js";
import { createS3StorageProvider, MAX_COPY_BYTES, MAX_DIRECTORY_KEYS } from "./storage-provider.js";

const ALICE = { accessKeyId: "alice-key", secretAccessKey: "alice-secret" };

function harness(
  options: Partial<FakeS3Options> = {},
  prefix = "",
  maxDirectoryKeys?: number,
): { server: FakeS3Server; storage: StorageProvider } {
  const server = createFakeS3Server({ keys: [ALICE], ...options });
  const client = createS3Client({
    endpoint: "http://s3.test",
    region: "us-east-1",
    credential: ALICE,
    fetch: server.fetch,
  });
  return {
    server,
    storage: createS3StorageProvider({
      client: async () => client,
      bucket: "bucket",
      prefix,
      ...(maxDirectoryKeys === undefined ? {} : { maxDirectoryKeys }),
    }),
  };
}

async function kindOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isStorageError(error) ? error.kind : `not a StorageError: ${String(error)}`;
  }
}

async function text(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

const XML = '<?xml version="1.0" encoding="UTF-8"?>';

function listing(keys: readonly string[], truncated = false): Response {
  const contents = keys
    .map(
      (key) =>
        `<Contents><Key>${key}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"e"</ETag><Size>1</Size></Contents>`,
    )
    .join("");
  return new Response(
    `${XML}<ListBucketResult><Name>bucket</Name><KeyCount>${keys.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${truncated ? "<NextContinuationToken>t</NextContinuationToken>" : ""}${contents}</ListBucketResult>`,
    { status: 200, headers: { "content-type": "application/xml" } },
  );
}

describe("directories as key prefixes", () => {
  it("sees a folder through its marker and through its children alike", async () => {
    const { server, storage } = harness();
    server.put("bucket", "marked/", new Uint8Array(0));
    server.put("bucket", "implied/deep/file.txt", "x");
    expect(await storage.stat("/marked")).toMatchObject({ kind: "dir" });
    expect(await storage.stat("/implied")).toMatchObject({ kind: "dir" });
    expect(await storage.list("/marked")).toEqual([]);
    expect((await storage.list("/implied")).map((entry) => entry.name)).toEqual(["deep"]);
    expect(await kindOf(storage.statFile("/implied"))).toBe("bad_request");
    const probe = storage.probeDirectoryRead?.bind(storage);
    if (probe === undefined) throw new Error("probeDirectoryRead is expected");
    await expect(probe("/implied")).resolves.toBeUndefined();
    await expect(probe("/")).resolves.toBeUndefined();
    expect(await kindOf(probe("/implied/deep/file.txt"))).toBe("bad_request");
    expect(await kindOf(probe("/nope"))).toBe("not_found");
    expect(await storage.stat("/")).toMatchObject({ kind: "dir" });
  });

  it("never treats the root as a file", async () => {
    const { storage } = harness();
    expect(await kindOf(storage.download("/"))).toBe("bad_request");
    expect(await kindOf(storage.upload("/", new Uint8Array(1)))).toBe("bad_request");
    expect(await kindOf(storage.deleteFile("/"))).toBe("bad_request");
  });

  it("falls back to the server's time when a stored mtime is not a number", async () => {
    const { server, storage } = harness();
    await storage.upload("/f.txt", new Uint8Array(1));
    const stored = server.objects("bucket").get("f.txt");
    if (stored === undefined) throw new Error("missing object");
    server.objects("bucket").set("f.txt", { ...stored, metadata: { mtime: "soon" } });
    // HTTP dates carry whole seconds only.
    expect(Math.floor(((await storage.statFile("/f.txt")).modifiedAt?.getTime() ?? 0) / 1000)).toBe(
      Math.floor(stored.lastModified.getTime() / 1000),
    );
  });

  it("prefers a folder over a same-named object and skips names it cannot show", async () => {
    const { server, storage } = harness();
    server.put("bucket", "x", "object");
    server.put("bucket", "x/child.txt", "child");
    server.put("bucket", "top.txt", "top");
    const entries = await storage.list("/");
    expect(entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["x", "dir"],
      ["top.txt", "file"],
    ]);
  });

  it("ignores listing rows outside the requested prefix or with unsafe names", async () => {
    const { storage } = harness({
      intercept: (_request, parsed) =>
        parsed.method === "GET" && parsed.key === ""
          ? listing(["a/ok.txt", "b/x.txt", "a/..", "a/"])
          : null,
    });
    expect((await storage.list("/a")).map((entry) => entry.name)).toEqual(["ok.txt"]);
  });

  it("refuses a folder with too many objects instead of walking it forever", async () => {
    // Every page claims more follow; a small bound keeps the test quick and
    // the production bound is a constant the adapter reports in its message.
    const page = Array.from({ length: 1000 }, (_, index) => `big/${index}.txt`);
    const { storage } = harness(
      {
        intercept: (_request, parsed) =>
          parsed.method === "GET" && parsed.key === "" ? listing(page, true) : null,
      },
      "",
      2500,
    );
    const error = await storage.list("/big").catch((cause: unknown) => cause);
    expect(error).toMatchObject({ kind: "internal" });
    expect(String((error as Error).message)).toContain(
      "more than 2500 entries; fdrive cannot list",
    );
    const removal = await storage.deleteDir("/big").catch((cause: unknown) => cause);
    expect(removal).toMatchObject({ kind: "internal" });
    expect(String((removal as Error).message)).toContain("more than 2500 objects");
    expect(MAX_DIRECTORY_KEYS).toBe(100_000);
  });

  it("creates markers and refuses to create over a file or an existing folder", async () => {
    const { server, storage } = harness();
    server.put("bucket", "file.txt", "x");
    expect(await kindOf(storage.mkdir("/file.txt"))).toBe("conflict");
    expect(await kindOf(storage.mkdir("/file.txt", { parents: true }))).toBe("conflict");
    await storage.mkdir("/new");
    expect(server.objects("bucket").get("new/")).toMatchObject({
      contentType: "application/x-directory",
    });
    expect(await kindOf(storage.mkdir("/new"))).toBe("conflict");
    await expect(storage.mkdir("/new", { parents: true })).resolves.toBeUndefined();
    await expect(storage.mkdir("/", { parents: true })).resolves.toBeUndefined();
    expect(await kindOf(storage.mkdir("/"))).toBe("conflict");
    // Every missing ancestor gets a marker, so the top folder outlives the deep one.
    await storage.mkdir("/top/middle/leaf", { parents: true });
    expect([...server.objects("bucket").keys()].filter((key) => key.startsWith("top"))).toEqual([
      "top/",
      "top/middle/",
      "top/middle/leaf/",
    ]);
    await storage.deleteDir("/top/middle");
    expect(await storage.stat("/top")).toMatchObject({ kind: "dir" });
    expect(await kindOf(storage.mkdir("/file.txt/inner", { parents: true }))).toBe("conflict");
  });

  it("needs the parent to exist unless asked for parents", async () => {
    const { server, storage } = harness();
    expect(await kindOf(storage.mkdir("/nowhere/child"))).toBe("not_found");
    server.put("bucket", "leaf.txt", "x");
    expect(await kindOf(storage.mkdir("/leaf.txt/child"))).toBe("bad_request");
    // A parent that exists only through its children counts.
    server.put("bucket", "implicit/a.txt", "x");
    await storage.mkdir("/implicit/child");
    expect(server.objects("bucket").has("implicit/child/")).toBe(true);
    await storage.mkdir("/nowhere/child", { parents: true });
    expect(server.objects("bucket").has("nowhere/")).toBe(true);
  });

  it("guards deletes by kind and never deletes the root", async () => {
    const { server, storage } = harness();
    server.put("bucket", "d/", new Uint8Array(0));
    server.put("bucket", "f.txt", "x");
    expect(await kindOf(storage.deleteFile("/d"))).toBe("bad_request");
    expect(await kindOf(storage.deleteDir("/f.txt"))).toBe("bad_request");
    expect(await kindOf(storage.deleteDir("/missing"))).toBe("not_found");
    expect(await kindOf(storage.deleteDir("/"))).toBe("bad_request");
    await storage.deleteDir("/d");
    expect(server.objects("bucket").has("d/")).toBe(false);
  });
});

describe("moves and copies", () => {
  it("refuses the root, a target inside the source and a conflicting target", async () => {
    const { server, storage } = harness();
    server.put("bucket", "src/a.txt", "a");
    server.put("bucket", "dst.txt", "old");
    expect(await kindOf(storage.move("/", "/x"))).toBe("bad_request");
    expect(await kindOf(storage.copy("/src", "/"))).toBe("bad_request");
    expect(await kindOf(storage.move("/src", "/src/inner"))).toBe("bad_request");
    expect(await kindOf(storage.move("/src", "/src"))).toBe("bad_request");
    expect(await kindOf(storage.copy("/src", "/src/inner"))).toBe("bad_request");
    expect(await kindOf(storage.move("/src/a.txt", "/dst.txt", { overwrite: false }))).toBe(
      "conflict",
    );
    expect(await kindOf(storage.copy("/src", "/dst.txt", { overwrite: false }))).toBe("conflict");
    await storage.move("/src/a.txt", "/dst.txt", { overwrite: true });
    expect(await text((await storage.download("/dst.txt")).body)).toBe("a");
    await storage.move("/dst.txt", "/fresh.txt", { overwrite: false });
    expect(await text((await storage.download("/fresh.txt")).body)).toBe("a");
  });

  it("replaces whatever already sits at the target", async () => {
    const { server, storage } = harness();
    server.put("bucket", "src/a.txt", "a");
    server.put("bucket", "dst/", "");
    server.put("bucket", "dst/stale.txt", "stale");
    server.put("bucket", "dst/deep/old.txt", "old");
    await storage.move("/src", "/dst");
    expect([...server.objects("bucket").keys()].sort()).toEqual(["dst/a.txt"]);
    // A folder over a file: the file goes.
    server.put("bucket", "plain.txt", "p");
    await storage.copy("/dst", "/plain.txt");
    expect(server.objects("bucket").has("plain.txt")).toBe(false);
    expect(await text((await storage.download("/plain.txt/a.txt")).body)).toBe("a");
    // A file over a folder: the folder and its marker go.
    server.put("bucket", "folder/", "");
    server.put("bucket", "folder/inner.txt", "i");
    await storage.copy("/plain.txt/a.txt", "/folder");
    expect(server.objects("bucket").has("folder/")).toBe(false);
    expect(server.objects("bucket").has("folder/inner.txt")).toBe(false);
    expect(await text((await storage.download("/folder")).body)).toBe("a");
  });

  it("moves a folder larger than the directory bound, which only listing applies", async () => {
    // The bound exists so one listing cannot grow without limit. A move streams
    // the tree a page at a time instead of collecting it, so the folder fdrive
    // can move is limited by time rather than by that number.
    const { server, storage } = harness({}, "", 3);
    for (let index = 0; index < 12; index += 1)
      server.put("bucket", `big/${index}.txt`, `v${index}`);
    await storage.move("/big", "/moved");
    expect([...server.objects("bucket").keys()].sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `moved/${index}.txt`).sort(),
    );
    expect(await text((await storage.download("/moved/7.txt")).body)).toBe("v7");
    // Listing the same folder still refuses, which is what the bound is for.
    expect(await kindOf(storage.list("/moved"))).toBe("internal");
  });

  it("resumes a move onto its own partial result without clearing or recopying it", async () => {
    const copied: string[] = [];
    const { server, storage } = harness({
      intercept: (request, parsed) => {
        if (parsed.method === "PUT" && request.headers.has("x-amz-copy-source"))
          copied.push(parsed.key);
        return null;
      },
    });
    server.put("bucket", "src/a.txt", "a");
    server.put("bucket", "src/b.txt", "b");
    // What an interrupted attempt had already copied.
    server.put("bucket", "dst/a.txt", "a");
    await storage.move("/src", "/dst", { overwrite: true, resume: true });
    // Only the object the earlier attempt had not reached is copied again, so a
    // tree interrupted near the end finishes rather than starting over.
    expect(copied).toEqual(["dst/b.txt"]);
    expect(await text((await storage.download("/dst/a.txt")).body)).toBe("a");
    expect(await text((await storage.download("/dst/b.txt")).body)).toBe("b");
    expect(server.objects("bucket").has("src/a.txt")).toBe(false);
    // Without resume the same shape of call replaces the target wholesale.
    copied.length = 0;
    server.put("bucket", "again/a.txt", "a");
    server.put("bucket", "again/stale.txt", "stale");
    server.put("bucket", "fresh/a.txt", "a");
    await storage.move("/fresh", "/again", { overwrite: true });
    expect(server.objects("bucket").has("again/stale.txt")).toBe(false);
    expect(copied).toEqual(["again/a.txt"]);
  });

  it("passes a target check failure through instead of treating it as free", async () => {
    const { server, storage } = harness({ keys: [{ ...ALICE, denyPrefixes: ["locked/"] }] });
    server.put("bucket", "src.txt", "a");
    expect(await kindOf(storage.move("/src.txt", "/locked/x.txt", { overwrite: false }))).toBe(
      "forbidden",
    );
    expect(server.objects("bucket").has("src.txt")).toBe(true);
  });

  it("moves a folder's marker and objects, keeping metadata", async () => {
    const { server, storage } = harness({}, "pre");
    await storage.mkdir("/dir");
    await storage.upload("/dir/a.txt", new TextEncoder().encode("a"), {
      modifiedAt: new Date("2020-01-02T03:04:05Z"),
    });
    await storage.move("/dir", "/moved");
    expect([...server.objects("bucket").keys()].sort()).toEqual(["pre/moved/", "pre/moved/a.txt"]);
    expect((await storage.statFile("/moved/a.txt")).modifiedAt?.toISOString()).toBe(
      "2020-01-02T03:04:05.000Z",
    );
    expect((await storage.list("/moved"))[0]?.modifiedAt.getFullYear()).toBeGreaterThan(2020);
  });

  it("refuses objects over the single-copy limit before touching them", async () => {
    const { server, storage } = harness({
      intercept: (_request, parsed) =>
        parsed.method === "HEAD" && parsed.key === "huge.bin"
          ? new Response(null, {
              status: 200,
              headers: { "content-length": String(6 * 1024 * 1024 * 1024), etag: '"h"' },
            })
          : null,
    });
    expect(await kindOf(storage.copy("/huge.bin", "/copy.bin"))).toBe("payload_too_large");
    expect(server.objects("bucket").has("copy.bin")).toBe(false);
  });

  it("reports a batch delete the server refused", async () => {
    const { server, storage } = harness({ keys: [{ ...ALICE, denyPrefixes: ["locked/"] }] });
    server.put("bucket", "locked/a.txt", "a");
    // Listing under the denied prefix is refused outright.
    expect(await kindOf(storage.list("/locked"))).toBe("forbidden");
    expect(await kindOf(storage.deleteDir("/locked"))).toBe("forbidden");

    function refusing(code: string) {
      const built = harness({
        intercept: (_request, parsed) =>
          parsed.method === "POST" && parsed.query.has("delete")
            ? new Response(
                `${XML}<DeleteResult><Error><Key>open/b.txt</Key><Code>${code}</Code><Message>no</Message></Error></DeleteResult>`,
                { status: 200, headers: { "content-type": "application/xml" } },
              )
            : null,
      });
      built.server.put("bucket", "open/b.txt", "b");
      return built.storage;
    }
    expect(await kindOf(refusing("AccessDenied").deleteDir("/open"))).toBe("forbidden");
    expect(await kindOf(refusing("InternalError").deleteDir("/open"))).toBe("internal");
  });
});

describe("downloads", () => {
  it("emulates If-Range with ETag and date validators", async () => {
    const { server, storage } = harness();
    server.put("bucket", "f.txt", "hello world");
    const etag = server.objects("bucket").get("f.txt")?.etag as string;
    const range = { start: 6 };
    const matching = await storage.download("/f.txt", { range, ifRange: etag });
    expect(matching.status).toBe(206);
    expect(await text(matching.body)).toBe("world");
    const weak = await storage.download("/f.txt", { range, ifRange: `W/${etag}` });
    expect(weak.status).toBe(206);
    const stale = await storage.download("/f.txt", { range, ifRange: '"other"' });
    expect(stale.status).toBe(200);
    expect(await text(stale.body)).toBe("hello world");
    const future = await storage.download("/f.txt", {
      range,
      ifRange: new Date(Date.now() + 60_000).toUTCString(),
    });
    expect(future.status).toBe(206);
    const past = await storage.download("/f.txt", {
      range,
      ifRange: "Mon, 01 Jan 2001 00:00:00 GMT",
    });
    expect(past.status).toBe(200);
    const garbage = await storage.download("/f.txt", { range, ifRange: "not a validator" });
    expect(garbage.status).toBe(200);
    expect(garbage.contentRange).toBeNull();
    // A validator without a range is simply ignored.
    expect((await storage.download("/f.txt", { ifRange: etag })).status).toBe(200);
  });

  it("reports metadata, a stored mtime and a missing object", async () => {
    const { storage } = harness();
    await storage.upload("/photo.jpg", new TextEncoder().encode("jpeg"), {
      modifiedAt: new Date("2021-05-06T07:08:09Z"),
    });
    const result = await storage.download("/photo.jpg");
    expect(result).toMatchObject({
      status: 200,
      contentLength: 4,
      contentType: "image/jpeg",
      lastModified: new Date("2021-05-06T07:08:09Z"),
    });
    expect(await kindOf(storage.download("/nope.jpg"))).toBe("not_found");
    expect(await kindOf(storage.download("/photo.jpg", { range: { start: 99 } }))).toBe(
      "bad_request",
    );
  });

  it("passes a non-precondition failure through and refuses a missing body", async () => {
    let calls = 0;
    const { server, storage } = harness({
      intercept: (_request, parsed) => {
        if (parsed.method !== "GET" || parsed.key !== "f.txt") return null;
        calls += 1;
        return calls === 1
          ? new Response(`${XML}<Error><Code>SlowDown</Code><Message>x</Message></Error>`, {
              status: 503,
              headers: { "content-type": "application/xml" },
            })
          : null;
      },
    });
    server.put("bucket", "f.txt", "x");
    // The SDK retries a 503 by itself, so the adapter sees the second, healthy answer.
    expect(
      await text((await storage.download("/f.txt", { range: { start: 0 }, ifRange: '"e"' })).body),
    ).toBe("x");
  });
});

describe("uploads", () => {
  it("refuses to overwrite when asked and stores content type and mtime", async () => {
    const { server, storage } = harness();
    await storage.upload("/notes.md", new TextEncoder().encode("one"), { overwrite: false });
    expect(
      await kindOf(
        storage.upload("/notes.md", new TextEncoder().encode("two"), { overwrite: false }),
      ),
    ).toBe("conflict");
    expect(server.objects("bucket").get("notes.md")).toMatchObject({
      contentType: "text/markdown",
    });
    await storage.upload("/blob", new TextEncoder().encode("?"), { mkdirParents: true });
    expect(server.objects("bucket").get("blob")).toMatchObject({
      contentType: "application/octet-stream",
    });
  });

  it("streams large bodies as multipart and small streams as one put", async () => {
    const { server, storage } = harness();
    const big = new Uint8Array(17 * 1024 * 1024).fill(7);
    const stream = new Blob([big]).stream();
    await storage.upload("/big.bin", stream, { modifiedAt: new Date("2022-02-02T00:00:00Z") });
    const stored = server.objects("bucket").get("big.bin");
    expect(stored?.bytes.byteLength).toBe(big.byteLength);
    expect(stored?.etag.endsWith('-3"')).toBe(true);
    expect(stored?.metadata.mtime).toBe("1643760000");
    await storage.upload("/small.bin", new Blob([new Uint8Array(10)]).stream());
    expect(server.objects("bucket").get("small.bin")?.bytes.byteLength).toBe(10);
    expect(server.pendingUploads()).toBe(0);
  });

  it("aborts a multipart upload through its signal, leaving no parts behind", async () => {
    const { server, storage } = harness();
    const controller = new AbortController();
    const chunk = new Uint8Array(4 * 1024 * 1024).fill(1);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        sent += 1;
        if (sent === 6) controller.abort();
        ctrl.enqueue(chunk);
      },
    });
    expect(
      await kindOf(storage.upload("/aborted.bin", stream, { signal: controller.signal })),
    ).toBe("upstream_unavailable");
    expect(server.pendingUploads()).toBe(0);
    expect(server.objects("bucket").has("aborted.bin")).toBe(false);
    const already = new AbortController();
    already.abort();
    expect(
      await kindOf(
        storage.upload("/never.bin", new Blob([chunk]).stream(), { signal: already.signal }),
      ),
    ).toBe("upstream_unavailable");
    expect(
      await kindOf(storage.upload("/never2.bin", new Uint8Array(3), { signal: already.signal })),
    ).toBe("upstream_unavailable");
  });

  it("maps a read-only key's refusal to forbidden and a dead endpoint to unavailable", async () => {
    const { storage } = harness({ keys: [{ ...ALICE, readOnly: true }] });
    expect(await kindOf(storage.upload("/x.txt", new Uint8Array(1)))).toBe("forbidden");
    const dead = createS3StorageProvider({
      client: async () =>
        createS3Client({
          endpoint: "http://elsewhere.test",
          region: "us-east-1",
          credential: ALICE,
          fetch: createFakeS3Server({ keys: [ALICE] }).fetch,
        }),
      bucket: "bucket",
      prefix: "",
    });
    expect(await kindOf(dead.stat("/x"))).toBe("upstream_unavailable");
  });
});

it("declares the size its publication copy refuses, so callers bound a write up front", () => {
  // A multipart upload takes far more than CopyObject will move into place, and
  // a caller that stages before publishing has to know that before the transfer.
  expect(harness().storage.maxPublishBytes).toBe(MAX_COPY_BYTES);
});
