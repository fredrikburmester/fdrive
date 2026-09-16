import { describe, expect, it } from "vitest";
import { createFakeS3Server } from "./fake/server.js";
import { errorCode, probeConnection } from "./probe.js";

function answering(response: () => Response | Promise<Response>): typeof globalThis.fetch {
  return (async () => response()) as unknown as typeof globalThis.fetch;
}

const ERROR_XML = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>m</Message></Error>`;

describe("errorCode", () => {
  it("reads the code of an S3 error body", () => {
    expect(errorCode(ERROR_XML("AccessDenied"))).toBe("AccessDenied");
    expect(errorCode("<html>nope</html>")).toBeNull();
  });
});

describe("probeConnection", () => {
  it("rejects an address that cannot work before sending anything", async () => {
    let called = false;
    const result = await probeConnection("http://host/", {
      fetch: answering(() => {
        called = true;
        return new Response();
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("must name the bucket");
    expect(called).toBe(false);
  });

  it("reports a network failure with the origin only", async () => {
    const result = await probeConnection("http://s3.test:9000/media", {
      fetch: answering(() => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(result).toEqual({
      ok: false,
      detail: "could not reach http://s3.test:9000: fetch failed",
    });
    const odd = await probeConnection("http://s3.test/media", {
      fetch: answering(() => {
        throw "boom";
      }),
    });
    expect(odd.detail).toBe("could not reach http://s3.test: network error");
  });

  it("refuses a redirect", async () => {
    const result = await probeConnection("http://s3.test/media", {
      fetch: answering(
        () => new Response(null, { status: 301, headers: { location: "http://x/" } }),
      ),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("redirected with 301");
  });

  it("reports a missing bucket", async () => {
    const result = await probeConnection("http://s3.test/media", {
      fetch: answering(() => new Response(ERROR_XML("NoSuchBucket"), { status: 404 })),
    });
    expect(result).toEqual({ ok: false, detail: "bucket media was not found on this endpoint" });
  });

  it("accepts an S3-shaped refusal as reachable", async () => {
    const byHeader = await probeConnection("http://s3.test/media", {
      fetch: answering(
        () => new Response("denied", { status: 403, headers: { "x-amz-request-id": "1" } }),
      ),
    });
    expect(byHeader).toEqual({
      ok: true,
      detail: "S3 bucket media is reachable and requires a login",
    });
    const byBody = await probeConnection("http://s3.test/media", {
      fetch: answering(() => new Response(ERROR_XML("AccessDenied"), { status: 401 })),
    });
    expect(byBody.ok).toBe(true);
  });

  it("accepts anonymous listing and refuses anything that is not S3", async () => {
    const listing = await probeConnection("http://s3.test/media", {
      fetch: answering(() => new Response('<ListBucketResult xmlns="x"></ListBucketResult>')),
    });
    expect(listing.detail).toContain("allows anonymous listing");
    const html = await probeConnection("http://s3.test/media", {
      fetch: answering(() => new Response("<html>login</html>", { status: 403 })),
    });
    expect(html).toEqual({ ok: false, detail: "bucket request returned 403; not an S3 endpoint" });
    const empty = await probeConnection("http://s3.test/media", {
      fetch: answering(() => new Response(null, { status: 404 })),
    });
    expect(empty.ok).toBe(false);
  });

  it("reports other S3 errors with their code", async () => {
    const result = await probeConnection("http://s3.test/media", {
      fetch: answering(() => new Response(ERROR_XML("InternalError"), { status: 500 })),
    });
    expect(result).toEqual({ ok: false, detail: "bucket request returned 500 (InternalError)" });
    const bare = await probeConnection("http://s3.test/media", {
      fetch: answering(() => new Response("x", { status: 500, headers: { "x-amz-id-2": "2" } })),
    });
    expect(bare.detail).toBe("bucket request returned 500");
  });

  it("reads at most a kilobyte of the body and survives a body that fails", async () => {
    const big = `${ERROR_XML("AccessDenied")}${"x".repeat(5000)}`;
    const result = await probeConnection("http://s3.test/media", {
      fetch: answering(() => new Response(big, { status: 403 })),
    });
    expect(result.ok).toBe(true);
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("boom"));
      },
    });
    const broken = await probeConnection("http://s3.test/media", {
      fetch: answering(() => new Response(failing, { status: 403 })),
    });
    expect(broken).toEqual({
      ok: false,
      detail: "bucket request returned 403; not an S3 endpoint",
    });
  });

  it("probes the fake unsigned and gets a refusal that proves the bucket", async () => {
    const server = createFakeS3Server({ keys: [], buckets: ["media"] });
    expect(await probeConnection("http://s3.test/media", { fetch: server.fetch })).toEqual({
      ok: true,
      detail: "S3 bucket media is reachable and requires a login",
    });
    expect(server.requests[0]).toMatchObject({ method: "GET", url: "http://s3.test/media/" });
    expect((await probeConnection("http://s3.test/other", { fetch: server.fetch })).detail).toBe(
      "bucket other was not found on this endpoint",
    );
  });
});
