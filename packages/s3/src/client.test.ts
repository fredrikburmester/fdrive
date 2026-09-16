import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createS3Client, DEFAULT_REGION, regionFor } from "./client.js";

describe("createS3Client", () => {
  it("sends path-style requests through the injected fetch, signed for the region", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const request = new Request(input);
      expect(request.url).toBe("http://s3.test:9000/media/");
      expect(request.headers.get("authorization")).toMatch(
        /^AWS4-HMAC-SHA256 Credential=ak\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=/,
      );
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = createS3Client({
      endpoint: "http://s3.test:9000",
      region: "eu-central-1",
      credential: { accessKeyId: "ak", secretAccessKey: "sk" },
      fetch: fetchImpl,
    });
    await client.send(new HeadBucketCommand({ Bucket: "media" }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up on a response that never arrives within the request timeout", async () => {
    const fetchImpl = ((input: Request) =>
      new Promise<Response>((_, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      })) as unknown as typeof globalThis.fetch;
    const client = createS3Client({
      endpoint: "http://s3.test",
      region: DEFAULT_REGION,
      credential: { accessKeyId: "ak", secretAccessKey: "sk" },
      fetch: fetchImpl,
      requestTimeoutMs: 10,
    });
    await expect(client.send(new HeadBucketCommand({ Bucket: "media" }))).rejects.toThrow();
  });
});

describe("regionFor", () => {
  it("uses the configured region, trimmed, else the default", () => {
    expect(regionFor({ region: " garage " })).toBe("garage");
    expect(regionFor({ region: "  " })).toBe(DEFAULT_REGION);
    expect(regionFor({})).toBe(DEFAULT_REGION);
    expect(regionFor({ region: 3 })).toBe(DEFAULT_REGION);
  });
});
