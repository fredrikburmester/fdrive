import type { S3Client } from "@aws-sdk/client-s3";
import { isStorageError, type StorageProvider } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { createS3StorageProvider } from "./storage-provider.js";

/**
 * A stubbed client answers what a lenient real server might: listings and
 * heads with fields missing, common prefixes that are not strings, a batch
 * delete error without key or code, and a read without a body. The fake
 * never produces these, so they are pinned here.
 */
function stubbed(send: (input: Record<string, unknown>, name: string) => unknown): StorageProvider {
  const client = {
    send: vi.fn(
      async (command: { input: Record<string, unknown>; constructor: { name: string } }) =>
        send(command.input, command.constructor.name),
    ),
  } as unknown as S3Client;
  return createS3StorageProvider({ client: async () => client, bucket: "b", prefix: "" });
}

async function kindOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isStorageError(error) ? error.kind : `not a StorageError: ${String(error)}`;
  }
}

describe("lenient server answers", () => {
  it("defaults missing sizes and dates and ignores odd common prefixes", async () => {
    const storage = stubbed((_input, name) => {
      if (name === "ListObjectsV2Command") {
        return {
          Contents: [{ Key: "a/f.txt" }, { Key: "a/" }, { Size: 3 }],
          CommonPrefixes: [{ Prefix: "a/x/y/" }, { Prefix: 3 }, { Prefix: "a/d/" }],
          IsTruncated: false,
        };
      }
      return {};
    });
    const entries = await storage.list("/a");
    expect(
      entries.map((entry) => [entry.name, entry.kind, entry.size, entry.modifiedAt.getTime()]),
    ).toEqual([
      ["d", "dir", 0, 0],
      ["f.txt", "file", 0, 0],
    ]);
    expect(await storage.statFile("/a/f.txt")).toEqual({
      size: 0,
      modifiedAt: null,
      contentType: null,
    });
  });

  it("reports a batch delete failure without key or code", async () => {
    const storage = stubbed((_input, name) => {
      if (name === "ListObjectsV2Command") return { Contents: [{ Key: "d/x" }] };
      if (name === "DeleteObjectsCommand") return { Errors: [{}] };
      return {};
    });
    const error = await storage.deleteDir("/d").catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      kind: "internal",
      message: "S3 refused to delete an object: unknown error",
    });
  });

  it("refuses a read that arrives without a body and reports missing response fields", async () => {
    const storage = stubbed((_input, name) => (name === "GetObjectCommand" ? {} : {}));
    expect(await kindOf(storage.download("/f"))).toBe("internal");
    const stream = new Blob(["x"]).stream();
    const withBody = stubbed(() => ({ Body: { transformToWebStream: () => stream } }));
    expect(await withBody.download("/f")).toMatchObject({
      status: 200,
      contentLength: null,
      contentRange: null,
      contentType: null,
      lastModified: null,
    });
  });
});
