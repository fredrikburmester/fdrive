import { describe, expect, it } from "vitest";
import { createMemoryStorage, entryStat } from "./memory-storage.ts";

/** The files and folders of a zip that stores its files as they are. */
function unzipStored(zip: Uint8Array): Record<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const decoder = new TextDecoder();
  const result: Record<string, string> = {};
  let at = view.getUint32(end + 16, true);
  for (let index = 0; index < view.getUint16(end + 10, true); index += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    result[name] = decoder.decode(zip.subarray(start, start + size));
    at += 46 + nameLength;
  }
  return result;
}

describe("createMemoryStorage extras", () => {
  it("seeds files, reports dirs, and stamps new files with the clock", async () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const storage = createMemoryStorage(
      { "/a/b.txt": "b", "/c.txt": new TextEncoder().encode("c") },
      { clock: () => at },
    );
    expect(storage.dump()).toEqual({ "/a/b.txt": "b", "/c.txt": "c" });
    expect(storage.dirs()).toEqual(["/", "/a"]);
    expect((await storage.statFile("/c.txt")).modifiedAt).toEqual(new Date(0));
    expect((await storage.download("/c.txt")).lastModified).toEqual(new Date(0));
    expect(await storage.upload("/d.txt", new TextEncoder().encode("d"))).toMatchObject({
      path: "/d.txt",
      name: "d.txt",
      kind: "file",
      size: 1,
      ext: ".txt",
      modifiedAt: at,
    });
  });

  it("reports what each write made, and the first folder a mkdir created", async () => {
    const storage = createMemoryStorage({ "/a/b.txt": "b" });
    expect(await storage.mkdir("/a/c/d", { parents: true })).toMatchObject({
      path: "/a/c/d",
      kind: "dir",
      created: "/a/c",
    });
    expect(await storage.mkdir("/a/c", { parents: true })).toMatchObject({ created: null });
    expect(await storage.mkdir("/e")).toMatchObject({ path: "/e", created: "/e" });
    await expect(storage.mkdir("/e")).rejects.toMatchObject({ kind: "conflict" });
    expect(await storage.copy("/a/b.txt", "/e/b.txt")).toMatchObject({
      path: "/e/b.txt",
      size: 1,
    });
    expect(await storage.copy("/a", "/f")).toMatchObject({ path: "/f", kind: "dir" });
    const moved = await storage.move("/e/b.txt", "/e/moved.txt");
    expect(moved).toMatchObject({ path: "/e/moved.txt", name: "moved.txt", kind: "file" });
    expect(moved.ino).toBe((await storage.stat("/e/moved.txt")).ino);
  });

  it("zips files, folders and the root, reporting files and bytes as it reads them", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "alpha", "/b.txt": "beta" });
    await storage.mkdir("/docs/empty");
    const progress: unknown[] = [];
    const zip = await storage.zip(["/docs", "/b.txt"], {
      onProgress: (step) => progress.push(step),
    });
    const bytes = new Uint8Array(await new Response(zip).arrayBuffer());
    expect(unzipStored(bytes)).toEqual({
      "docs/a.txt": "alpha",
      "docs/empty/": "",
      "b.txt": "beta",
    });
    expect(progress).toEqual([
      { processed: 0, total: 2, bytes: 0 },
      { processed: 1, total: 2, bytes: 5 },
      { processed: 2, total: 2, bytes: 9 },
    ]);
    const root = await new Response(await storage.zip(["/"])).arrayBuffer();
    expect(Object.keys(unzipStored(new Uint8Array(root))).sort()).toEqual([
      "b.txt",
      "docs/a.txt",
      "docs/empty/",
    ]);
    await expect(storage.zip(["/nope"])).rejects.toMatchObject({ kind: "not_found" });
    await expect(storage.zip(["/b.txt"], { signal: AbortSignal.abort() })).rejects.toThrow();
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

  it("publishes an upload sent in pieces only at the last, refusing a gap", async () => {
    const storage = createMemoryStorage();
    const encode = (value: string) => new TextEncoder().encode(value);
    const piece = (offset: number) => ({ part: { id: "0123456789abcdef", offset } });
    await storage.uploadPart("/p.txt", encode("hel"), piece(0));
    await expect(storage.uploadPart("/p.txt", encode("?"), piece(9))).rejects.toMatchObject({
      kind: "bad_request",
    });
    expect(storage.dump()).toEqual({});
    expect(await storage.upload("/p.txt", encode("lo"), piece(3))).toMatchObject({ size: 5 });
    expect(storage.dump()).toEqual({ "/p.txt": "hello" });
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

  it("refuses at publish a name something else took while the body was staged", async () => {
    const storage = createMemoryStorage({ "/dir/.keep": "" });
    const meanwhile = (take: () => Promise<unknown>) => ({
      critical: async <T>(work: () => Promise<T>) => {
        await take();
        return work();
      },
    });
    await expect(
      storage.upload(
        "/dir/a.txt",
        new Uint8Array([1]),
        meanwhile(() => storage.upload("/dir/a.txt", new Uint8Array([2]))),
      ),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(
      storage.upload(
        "/dir/b",
        new Uint8Array([1]),
        meanwhile(() => storage.mkdir("/dir/b")),
      ),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(storage.dump()).toEqual({ "/dir/.keep": "", "/dir/a.txt": "\u0002" });
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

  it("removes only an empty directory, never the root", async () => {
    const storage = createMemoryStorage({ "/full/a.txt": "a" });
    await storage.mkdir("/empty/inner", { parents: true });
    await expect(storage.deleteEmptyDir("/full")).rejects.toMatchObject({ kind: "conflict" });
    await expect(storage.deleteEmptyDir("/empty")).rejects.toMatchObject({ kind: "conflict" });
    await expect(storage.deleteEmptyDir("/full/a.txt")).rejects.toMatchObject({
      kind: "bad_request",
    });
    await expect(storage.deleteEmptyDir("/nope")).rejects.toMatchObject({ kind: "not_found" });
    await storage.deleteEmptyDir("/empty/inner");
    await storage.deleteEmptyDir("/empty");
    expect(storage.dirs()).toEqual(["/", "/full"]);
    await storage.deleteFile("/full/a.txt");
    await storage.deleteEmptyDir("/full");
    await expect(storage.deleteEmptyDir("/")).rejects.toMatchObject({ kind: "bad_request" });
    expect(storage.dirs()).toEqual(["/"]);
  });
});

it("preserves read, probe, range and timestamp semantics", async () => {
  const storage = createMemoryStorage({ "/dir/f.txt": "hello" });
  await storage.probeDirectoryRead("/dir");
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
  await storage.upload("/dir/f.txt", new Uint8Array(), { overwrite: true, modifiedAt: at });
  expect((await storage.statFile("/dir/f.txt")).modifiedAt).toEqual(at);
  await expect(storage.move("/dir/f.txt", "/dir")).rejects.toMatchObject({ kind: "conflict" });
  await expect(storage.copy("/", "/other")).rejects.toMatchObject({ kind: "not_found" });
});

it("stamps files as a disk does: every write moves the stamp, reads leave it", async () => {
  const at = new Date("2026-01-01T00:00:00.123Z");
  const storage = createMemoryStorage({ "/a.txt": "a", "/dir/b.txt": "b" }, { clock: () => at });
  const first = await storage.contentStamp("/a.txt");
  expect(first).toMatchObject({ size: 1, mtimeNs: 0n });
  await storage.download("/a.txt");
  expect(await storage.contentStamp("/a.txt")).toEqual(first);
  await storage.upload("/a.txt", new TextEncoder().encode("z"), {
    modifiedAt: new Date(0),
    overwrite: true,
  });
  const rewritten = await storage.contentStamp("/a.txt");
  expect(rewritten).toMatchObject({ size: 1, mtimeNs: 0n });
  expect(rewritten.ino).not.toBe(first.ino);
  await storage.upload("/c.txt", new TextEncoder().encode("c"));
  expect((await storage.contentStamp("/c.txt")).mtimeNs).toBe(1767225600123000000n);
  await expect(storage.contentStamp("/dir")).rejects.toMatchObject({ kind: "bad_request" });
  await expect(storage.contentStamp("/none")).rejects.toMatchObject({ kind: "not_found" });
  await expect(
    storage.upload("/short.txt", new TextEncoder().encode("ab"), { contentLength: 3 }),
  ).rejects.toMatchObject({ kind: "bad_request" });
  await expect(storage.statFile("/short.txt")).rejects.toMatchObject({ kind: "not_found" });
});

it("renames as a disk does: files and folders keep their inodes, copies get new ones", async () => {
  const storage = createMemoryStorage({ "/a/b/c.txt": "c", "/d.txt": "d" });
  const folder = (await storage.stat("/a")).ino;
  const file = (await storage.stat("/a/b/c.txt")).ino;
  expect(folder).toBeTypeOf("bigint");
  await storage.move("/a", "/moved");
  expect((await storage.stat("/moved")).ino).toBe(folder);
  expect((await storage.stat("/moved/b/c.txt")).ino).toBe(file);
  await storage.copy("/moved", "/copied");
  expect(storage.dump()["/copied/b/c.txt"]).toBe("c");
  expect((await storage.stat("/copied/b/c.txt")).ino).not.toBe(file);
  await expect(storage.move("/moved", "/moved/b/inside")).rejects.toMatchObject({
    kind: "bad_request",
  });
  const before = await storage.contentStamp("/d.txt");
  await storage.move("/d.txt", "/e.txt");
  const after = await storage.contentStamp("/e.txt");
  expect(after.ino).toBe(before.ino);
  expect(after.ctimeNs).not.toBe(before.ctimeNs);
});

it("builds the entry a stat reports, for tests that stand in for storage", () => {
  expect(entryStat("/docs/a.txt")).toEqual({
    name: "a.txt",
    path: "/docs/a.txt",
    kind: "file",
    size: 0,
    modifiedAt: new Date(0),
    ext: ".txt",
    ino: 0n,
  });
  const at = new Date("2024-01-01Z");
  expect(entryStat("docs", { kind: "dir", size: 3, modifiedAt: at, ino: 7n })).toEqual({
    name: "docs",
    path: "/docs",
    kind: "dir",
    size: 3,
    modifiedAt: at,
    ext: "",
    ino: 7n,
  });
});
