import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./memory-storage.ts";

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
    for (const opts of [undefined, { overwrite: false }]) {
      await expect(storage.copy("/other.txt", "/dst", opts)).rejects.toMatchObject({
        kind: "conflict",
        message: "something already exists at /dst",
      });
    }
    await storage.copy("/other.txt", "/dst", { overwrite: true });
    expect(storage.dump()).toEqual({ "/dst": "f", "/other.txt": "f" });
    await storage.mkdir("/tree");
    await storage.copy("/tree", "/dst", { overwrite: true });
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

  it("refuses statFile on a directory and empties a root that never had children", async () => {
    const storage = createMemoryStorage();
    await expect(storage.statFile("/")).rejects.toMatchObject({ kind: "bad_request" });
    await storage.deleteDir("/");
    expect(storage.dirs()).toEqual(["/"]);
  });
});

it("preserves read, probe, range and timestamp semantics", async () => {
  const storage = createMemoryStorage(
    { "/dir/f.txt": "hello" },
    { nullMtimePaths: ["/dir/f.txt"] },
  );
  await storage.probeDirectoryRead?.("/dir");
  expect(await storage.list("/dir")).toMatchObject([{ name: "f.txt", modifiedAt: new Date(0) }]);
  await expect(storage.list("/dir/f.txt")).rejects.toMatchObject({ kind: "bad_request" });
  await expect(storage.list("/missing")).rejects.toMatchObject({ kind: "not_found" });
  await expect(storage.download("/dir/f.txt", { signal: AbortSignal.abort() })).rejects.toThrow();
  for (const range of [{ start: 1, end: 3 }, { start: 1 }]) {
    const result = await storage.download("/dir/f.txt", { range });
    expect(result.status).toBe(206);
    expect(await new Response(result.body).text()).toBe(range.end === 3 ? "ell" : "ello");
  }
  const at = new Date("2021-01-01Z");
  await storage.setModifiedAt?.("/dir/f.txt", at);
  expect((await storage.statFile("/dir/f.txt")).modifiedAt).toEqual(at);
  await expect(storage.move("/dir/f.txt", "/dir")).rejects.toMatchObject({ kind: "conflict" });
  await expect(storage.copy("/", "/other")).rejects.toMatchObject({ kind: "not_found" });
});

it("stamps files as a disk does: every write moves the stamp, reads leave it", async () => {
  const at = new Date("2026-01-01T00:00:00.123Z");
  const storage = createMemoryStorage({ "/a.txt": "a", "/dir/b.txt": "b" }, { clock: () => at });
  const first = await storage.contentStamp?.("/a.txt");
  expect(first).toMatchObject({ size: 1, mtimeNs: 0n });
  await storage.download("/a.txt");
  expect(await storage.contentStamp?.("/a.txt")).toEqual(first);
  await storage.upload("/a.txt", new TextEncoder().encode("z"), {
    modifiedAt: new Date(0),
    overwrite: true,
  });
  const rewritten = await storage.contentStamp?.("/a.txt");
  expect(rewritten).toMatchObject({ size: 1, mtimeNs: 0n });
  expect(rewritten?.ino).not.toBe(first?.ino);
  await storage.setModifiedAt?.("/a.txt", new Date(0));
  const touched = await storage.contentStamp?.("/a.txt");
  expect(touched?.ino).toBe(rewritten?.ino);
  expect(touched?.ctimeNs).not.toBe(rewritten?.ctimeNs);
  await storage.upload("/c.txt", new TextEncoder().encode("c"));
  expect((await storage.contentStamp?.("/c.txt"))?.mtimeNs).toBe(1767225600123000000n);
  await expect(storage.contentStamp?.("/dir")).rejects.toMatchObject({ kind: "bad_request" });
  await expect(storage.contentStamp?.("/none")).rejects.toMatchObject({ kind: "not_found" });
  await expect(
    storage.upload("/short.txt", new TextEncoder().encode("ab"), { contentLength: 3 }),
  ).rejects.toMatchObject({ kind: "bad_request" });
  await expect(storage.statFile("/short.txt")).rejects.toMatchObject({ kind: "not_found" });
});
