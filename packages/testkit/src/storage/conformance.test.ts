import type { StorageProvider } from "@fdrive/core";
import { describe, expect, it } from "vitest";
import { describeStorageProvider } from "./conformance.ts";
import { createMemoryStorage } from "./memory-storage.ts";

describeStorageProvider("memory storage", () => ({ storage: createMemoryStorage() }));

describeStorageProvider(
  "memory storage with a fixed workspace",
  () => ({ storage: createMemoryStorage(), cleanup: async () => {} }),
  { workspace: "/work", probe: false },
);

/** Memory storage dressed as a backend that overwrites on move, zips, and has no mtime or probe. */
function overwritingZippingStorage(): StorageProvider {
  const base = createMemoryStorage();
  const { setModifiedAt: _mtime, probeDirectoryRead: _probe, ...rest } = base;
  return {
    ...rest,
    move: (path, target, opts) => base.move(path, target, { overwrite: opts?.overwrite ?? true }),
    zip: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]));
          controller.close();
        },
      }),
  };
}

describeStorageProvider(
  "overwriting, zipping storage without mtime or probe",
  () => ({ storage: overwritingZippingStorage() }),
  { overwritesOnMove: true },
);

describe("createMemoryStorage extras", () => {
  it("seeds files, reports dirs, and honours null mtimes and the clock", async () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const storage = createMemoryStorage(
      { "/a/b.txt": "b", "/c.txt": new TextEncoder().encode("c") },
      { nullMtimePaths: ["/c.txt"], clock: () => at },
    );
    expect(storage.dump()).toEqual({ "/a/b.txt": "b", "/c.txt": "c" });
    expect(storage.dirs()).toEqual(["/", "/a"]);
    expect((await storage.statFile("/c.txt")).modifiedAt).toBeNull();
    expect((await storage.download("/c.txt")).lastModified).toBeNull();
    await storage.upload("/d.txt", new TextEncoder().encode("d"));
    expect((await storage.statFile("/d.txt")).modifiedAt).toEqual(at);
    expect(storage.zip).toBeUndefined();
  });

  it("accepts a streamed upload body", async () => {
    const storage = createMemoryStorage();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("str"));
        controller.enqueue(new TextEncoder().encode("eam"));
        controller.close();
      },
    });
    await storage.upload("/s.txt", body);
    expect(storage.dump()).toEqual({ "/s.txt": "stream" });
  });

  it("refuses uploads over directories, unknown parents and, on request, existing files", async () => {
    const storage = createMemoryStorage({ "/x/y.txt": "y" });
    await expect(storage.upload("/x", new Uint8Array())).rejects.toMatchObject({
      kind: "conflict",
    });
    await expect(storage.upload("/nope/z.txt", new Uint8Array())).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(
      storage.upload("/x/y.txt", new Uint8Array(), { overwrite: false }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(storage.mkdir("/x/y.txt")).rejects.toMatchObject({ kind: "conflict" });
    await expect(storage.mkdir("/nope/dir")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("overwrites on move and copy only when asked, replacing files or trees", async () => {
    const storage = createMemoryStorage({
      "/src/a.txt": "a",
      "/dst/b.txt": "b",
      "/file.txt": "f",
      "/other.txt": "o",
    });
    await storage.move("/src", "/dst", { overwrite: true });
    expect(storage.dump()).toEqual({ "/dst/a.txt": "a", "/file.txt": "f", "/other.txt": "o" });
    await storage.move("/file.txt", "/other.txt", { overwrite: true });
    expect(storage.dump()).toEqual({ "/dst/a.txt": "a", "/other.txt": "f" });
    await expect(storage.copy("/other.txt", "/dst", { overwrite: false })).rejects.toMatchObject({
      kind: "conflict",
    });
    await storage.copy("/other.txt", "/dst");
    expect(storage.dump()).toEqual({ "/dst": "f", "/other.txt": "f" });
    await storage.mkdir("/tree");
    await storage.copy("/tree", "/dst");
    expect(storage.dirs()).toContain("/dst");
    expect(storage.dump()).toEqual({ "/other.txt": "f" });
    await expect(storage.copy("/nope", "/x")).rejects.toMatchObject({ kind: "not_found" });
    await expect(storage.move("/", "/x")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("empties the root without removing it and downloads ranges past the end whole", async () => {
    const storage = createMemoryStorage({ "/a.txt": "abc", "/d/e.txt": "e" });
    await storage.deleteDir("/");
    expect(storage.dump()).toEqual({});
    expect(storage.dirs()).toEqual(["/"]);
    await storage.upload("/a.txt", new TextEncoder().encode("abc"));
    const past = await storage.download("/a.txt", { range: { start: 10 } });
    expect(past.status).toBe(200);
    await expect(storage.deleteDir("/nope")).rejects.toMatchObject({ kind: "not_found" });
  });
});
