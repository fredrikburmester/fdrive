import { Readable } from "node:stream";
import { StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { expect, it, vi } from "vitest";
import { isBackupPath, withoutBackupPaths } from "./reserved-storage.js";

it("hides backup paths from browsing and refuses reads, writes and ancestor mutation", async () => {
  const raw = Object.assign(createMemoryStorage(), {
    zip: vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
    ),
    marker: "memory",
  });
  await raw.mkdir("/private");
  await raw.mkdir("/private/.fdrive-backups");
  await raw.upload("/private/.fdrive-backups/snapshot", new Uint8Array([1]));
  await raw.upload("/private/visible", new Uint8Array([2]));
  const storage = withoutBackupPaths(raw);
  expect(isBackupPath("/private/.FDRIVE-BACKUPS/file")).toBe(true);
  expect((await storage.list("/private")).map((item) => item.name)).toEqual(["visible"]);
  await expect(storage.list("/private/.fdrive-backups")).rejects.toMatchObject({
    kind: "forbidden",
  });
  await expect(storage.download("/private/.fdrive-backups/snapshot")).rejects.toMatchObject({
    kind: "forbidden",
  });
  await expect(
    storage.upload("/private/.fdrive-backups/new", new Uint8Array()),
  ).rejects.toMatchObject({ kind: "forbidden" });
  await expect(storage.copy("/private", "/copy")).rejects.toMatchObject({ kind: "forbidden" });
  await expect(storage.move("/private", "/copy")).rejects.toMatchObject({ kind: "forbidden" });
  await expect(storage.deleteDir("/private")).rejects.toMatchObject({ kind: "forbidden" });
  await expect(storage.zip?.(["/private"])).rejects.toMatchObject({ kind: "forbidden" });
  await expect(
    storage.copy("/private/visible", "/private/.fdrive-backups/new"),
  ).rejects.toMatchObject({ kind: "forbidden" });
  await storage.copy("/private/visible", "/copy");
  await storage.move("/copy", "/moved");
  await storage.deleteFile("/moved");
  const zip = await storage.zip?.(["/private/visible"]);
  for await (const _ of Readable.fromWeb(
    zip as import("node:stream/web").ReadableStream<Uint8Array>,
  )) {
    /* drain */
  }
  expect(await raw.stat("/private/.fdrive-backups/snapshot")).toHaveProperty("size", 1);
  expect(Reflect.get(storage, "marker")).toBe("memory");
});
it("keeps protection inside write leases and rejects malformed provider listings", async () => {
  const raw = Object.assign(createMemoryStorage(), {
    zip: vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
    ),
    marker: "memory",
  });
  const lease = vi.fn(async (action: Parameters<NonNullable<typeof raw.withWriteLease>>[0]) =>
    action(raw),
  );
  const storage = withoutBackupPaths({
    ...raw,
    withWriteLease: lease as NonNullable<typeof raw.withWriteLease>,
  });
  await expect(
    storage.withWriteLease?.((leased) => leased.mkdir("/.fdrive-backups")),
  ).rejects.toMatchObject({ kind: "forbidden" });
  await raw.mkdir("/dir");
  const list = vi
    .spyOn(raw, "list")
    .mockResolvedValue([
      { kind: "dir", name: "escape", path: "/elsewhere", size: 0, modifiedAt: new Date(), ext: "" },
    ]);
  await expect(withoutBackupPaths(raw).zip?.(["/dir"])).rejects.toThrow("Invalid directory");
  list.mockRestore();
  const stat = vi
    .spyOn(raw, "stat")
    .mockRejectedValue(new StorageError("upstream_unavailable", "offline"));
  await expect(withoutBackupPaths(raw).deleteDir("/dir")).rejects.toThrow("offline");
  stat.mockRestore();
});

it("bounds recursive operations and allows ordinary nested directories", async () => {
  const raw = createMemoryStorage({ "/ordinary/sub/file": "bytes" });
  const storage = withoutBackupPaths(raw);
  await storage.copy("/ordinary", "/copy");
  await storage.deleteDir("/copy");
  expect(await raw.stat("/ordinary/sub/file")).toHaveProperty("size", 5);
  vi.spyOn(raw, "list").mockImplementation(async (path) => [
    { path: `${path}/dir`, name: "dir", kind: "dir", size: 0, ext: "", modifiedAt: new Date() },
  ]);
  await expect(storage.deleteDir("/ordinary")).rejects.toThrow("deeply nested");
});
