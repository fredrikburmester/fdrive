import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createMemoryStorage } from "@fdrive/core/testing";
import { afterEach, beforeEach, expect, it, type MockInstance, vi } from "vitest";
import {
  probeDestination,
  providerDestination,
  s3Destination,
  verifyDelivery,
} from "../src/destinations.js";
import { readBounded } from "../src/streams.js";
import { memoryDestination, required } from "./helpers.js";

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "backup-dest-"));
  file = join(directory, "file");
  await writeFile(file, "bytes");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const config = {
  endpoint: "https://s3.example.invalid",
  region: "test",
  bucket: "test",
  prefix: "snapshots/installation",
  pathStyle: true,
  accessKeyId: "test",
  secretAccessKey: "test",
};
it("uses explicit versions, paginated scoped keys and bounded multipart upload options", async () => {
  const send = vi.spyOn(S3Client.prototype, "send") as unknown as MockInstance<
    (input: unknown) => Promise<Record<string, unknown>>
  >;
  send
    .mockResolvedValueOnce({ VersionId: "v1", ObjectLockRetainUntilDate: new Date("2026-12-01Z") })
    .mockResolvedValueOnce({ Status: "Enabled" });
  const destination = s3Destination(config);
  expect(await destination.information("a.age")).toEqual({
    versionId: "v1",
    retentionUntil: "2026-12-01T00:00:00.000Z",
    versioning: "Enabled",
  });
  send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
  expect(await destination.information("a.age")).toEqual({ versioning: "disabled" });
  send.mockResolvedValueOnce({}).mockRejectedValueOnce(Error("AccessDenied"));
  expect(await destination.information("a.age")).toEqual({ versioning: "unknown" });
  send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
  expect(await destination.information("a.age")).toBeNull();
  send.mockRejectedValueOnce(Error("denied"));
  await expect(destination.information("a.age")).rejects.toThrow("denied");
  send.mockResolvedValueOnce({
    Body: { transformToWebStream: () => Readable.toWeb(Readable.from([Buffer.from("download")])) },
  });
  expect((await readBounded(await destination.get("a.age", "v1"))).toString()).toBe("download");
  send.mockResolvedValueOnce({});
  await expect(destination.get("a.age")).rejects.toThrow("no body");
  send
    .mockResolvedValueOnce({
      Contents: [
        { Key: "snapshots/installation/a.age" },
        { Key: "snapshots/installation/sub/a" },
        {},
      ],
      IsTruncated: true,
      NextContinuationToken: "next",
    })
    .mockResolvedValueOnce({});
  expect(await destination.list()).toEqual(["a.age"]);
  send.mockResolvedValueOnce({});
  await destination.remove("a.age", "v1");
  send.mockResolvedValueOnce({});
  await destination.remove("a.age");
  const done = vi
    .spyOn(Upload.prototype, "done")
    .mockResolvedValueOnce({ VersionId: "uploaded", $metadata: {} })
    .mockResolvedValueOnce({ $metadata: {} });
  expect(await destination.put("a.age", file)).toEqual({ versionId: "uploaded" });
  expect(await destination.put("b.age", file)).toEqual({});
  expect(done).toHaveBeenCalledTimes(2);
});
it("aborts multipart requests and surfaces listing limits", async () => {
  const controller = new AbortController();
  const abort = vi.spyOn(Upload.prototype, "abort").mockResolvedValue();
  vi.spyOn(Upload.prototype, "done").mockImplementation(async () => {
    controller.abort();
    throw Error("aborted");
  });
  const destination = s3Destination(config);
  await expect(destination.put("a.age", file, controller.signal)).rejects.toThrow("aborted");
  expect(abort).toHaveBeenCalled();
  await expect(destination.put("b.age", file, controller.signal)).rejects.toThrow();
  (
    vi.spyOn(S3Client.prototype, "send") as unknown as MockInstance<
      (input: unknown) => Promise<Record<string, unknown>>
    >
  ).mockResolvedValueOnce({
    Contents: Array.from({ length: 100_001 }, (_, index) => ({
      Key: `snapshots/installation/${index}`,
    })),
  });
  await expect(destination.list()).rejects.toThrow("limit");
});
it("supports raw fileserver I/O without ordinary Trash effects", async () => {
  const storage = createMemoryStorage();
  await storage.mkdir("/backups", { parents: true });
  const destination = providerDestination(storage, "/backups");
  expect(await destination.information("missing")).toBeNull();
  expect(await destination.put("a.age", file, new AbortController().signal)).toEqual({});
  expect(await destination.information("a.age")).toEqual({});
  expect((await readBounded(await destination.get("a.age"))).toString()).toBe("bytes");
  expect(await destination.list()).toEqual(["a.age"]);
  await storage.mkdir("/backups/sub");
  expect(await destination.list()).toEqual(["a.age"]);
  await destination.remove("a.age");
  await expect(destination.get("a.age")).rejects.toThrow();
  vi.spyOn(storage, "statFile").mockRejectedValue(Error("offline"));
  await expect(destination.information("x")).rejects.toThrow("offline");
});
it("cleans only its probe, retries incomplete bytes and rejects corrupted readbacks", async () => {
  const remote = memoryDestination();
  await probeDestination(remote.destination);
  expect(remote.objects.size).toBe(0);
  await remote.destination.put("a.age", file);
  required(remote.objects.get("a.age")).bytes = Buffer.from("bad");
  await verifyDelivery(remote.destination, "a.age", file);
  expect(remote.objects.get("a.age")?.bytes.toString()).toBe("bytes");
  vi.spyOn(remote.destination, "get").mockResolvedValueOnce(
    Readable.from([Buffer.from("tampered")]),
  );
  await expect(verifyDelivery(remote.destination, "b.age", file)).rejects.toThrow("readback");
  vi.spyOn(remote.destination, "get").mockResolvedValueOnce(
    Readable.from([Buffer.from("bad probe")]),
  );
  await expect(probeDestination(remote.destination)).rejects.toThrow("probe");
  expect([...remote.objects.keys()].filter((key) => key.startsWith("probe-"))).toEqual([]);
  remote.offline(true);
  await expect(probeDestination(remote.destination)).rejects.toThrow("offline");
});
it("keeps a retained probe only when the destination itself reports retention for it", async () => {
  const remote = memoryDestination();
  vi.spyOn(remote.destination, "remove").mockRejectedValueOnce(Error("denied"));
  await expect(probeDestination(remote.destination)).rejects.toThrow("denied");
  expect(remote.objects.size).toBe(1);
  remote.lock(true);
  const probe = await probeDestination(remote.destination);
  expect(probe.retained).toEqual({
    name: expect.stringMatching(/^probe-/),
    retentionUntil: "2030-01-01T00:00:00.000Z",
  });
  expect(remote.objects.size).toBe(2);
  expect([...remote.objects.keys()].every((key) => key.startsWith("probe-"))).toBe(true);
  vi.spyOn(remote.destination, "information").mockRejectedValueOnce(Error("offline"));
  await expect(probeDestination(remote.destination)).rejects.toThrow("Object Lock");
  remote.lock(false);
  expect((await probeDestination(remote.destination)).retained).toBeNull();
  expect(remote.objects.size).toBe(3);
});
it("cancels readback when a transfer is aborted", async () => {
  const remote = memoryDestination();
  const controller = new AbortController();
  vi.spyOn(remote.destination, "get").mockImplementation(async () => {
    const stream = new Readable({
      read() {
        controller.abort();
      },
    });
    return stream;
  });
  await expect(
    verifyDelivery(remote.destination, "cancel.age", file, controller.signal),
  ).rejects.toThrow("aborted");
  await remote.destination.put("existing.age", file);
  const retry = new AbortController();
  vi.spyOn(remote.destination, "get").mockImplementation(
    async () =>
      new Readable({
        read() {
          retry.abort();
        },
      }),
  );
  await expect(
    verifyDelivery(remote.destination, "existing.age", file, retry.signal),
  ).rejects.toThrow("aborted");
  expect(remote.objects.has("existing.age")).toBe(true);
});
