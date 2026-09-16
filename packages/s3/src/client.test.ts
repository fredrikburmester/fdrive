import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createS3Client, DEFAULT_REGION, inferRegion, regionFor } from "./client.js";

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

  it("reads the region from a hosted endpoint when none is configured", () => {
    expect(regionFor({}, "https://s3.us-west-004.backblazeb2.com")).toBe("us-west-004");
    expect(regionFor({ region: "eu-central-003" }, "https://s3.us-west-004.backblazeb2.com")).toBe(
      "eu-central-003",
    );
    expect(regionFor({}, "http://minio.local:9000")).toBe(DEFAULT_REGION);
  });
});

describe("inferRegion", () => {
  it("knows B2, AWS, R2 and Hetzner hostnames", () => {
    expect(inferRegion("https://s3.us-west-004.backblazeb2.com")).toBe("us-west-004");
    expect(inferRegion("https://s3.eu-central-1.amazonaws.com")).toBe("eu-central-1");
    expect(inferRegion("https://S3.AP-SOUTHEAST-2.amazonaws.com")).toBe("ap-southeast-2");
    expect(inferRegion("https://abc123.r2.cloudflarestorage.com")).toBe("auto");
    expect(inferRegion("https://fsn1.your-objectstorage.com")).toBe("fsn1");
  });

  it("stays out of self-hosted and unrecognised addresses", () => {
    expect(inferRegion("http://minio.local:9000")).toBeNull();
    expect(inferRegion("https://s3.example.com")).toBeNull();
    expect(inferRegion("https://s3.garage.example.com")).toBeNull();
    expect(inferRegion("https://bucket.fsn1.your-objectstorage.com")).toBeNull();
    expect(inferRegion("not a url")).toBeNull();
  });
});
