import { isStorageError, type StorageProvider, type ZipProgress } from "@fdrive/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unzip } from "./unzip.js";

export interface StorageFactoryResult {
  readonly storage: StorageProvider;
  /** Called after each test; tear down anything the factory allocated. */
  cleanup?(): Promise<void>;
}

/** Builds a fresh, empty storage for one test. */
export type StorageFactory = () => Promise<StorageFactoryResult> | StorageFactoryResult;

async function text(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

async function kindOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isStorageError(error) ? error.kind : `not a StorageError: ${String(error)}`;
  }
}

/**
 * The behavioural contract every `StorageProvider` passes, every member of
 * it: the files folder (`@fdrive/local`) and the memory storage, so anything
 * tested on the fake holds for the files folder. Each test gets a fresh
 * storage from `factory` and works in a folder of its own.
 */
export function describeStorageProvider(name: string, factory: StorageFactory): void {
  describe(`StorageProvider conformance: ${name}`, () => {
    let storage: StorageProvider;
    let cleanup: (() => Promise<void>) | undefined;
    let root: string;

    beforeEach(async () => {
      // No test may pass by asserting nothing: the suite skips nothing.
      expect.hasAssertions();
      const result = await factory();
      storage = result.storage;
      cleanup = result.cleanup?.bind(result);
      root = `/conformance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await storage.mkdir(root);
    });

    afterEach(async () => {
      await cleanup?.();
    });

    async function seed(relative: string, content: string): Promise<string> {
      const path = `${root}/${relative}`;
      await storage.upload(path, new TextEncoder().encode(content), { mkdirParents: true });
      return path;
    }

    it("lists files and directories with kind, size and extension", async () => {
      await seed("docs/a.txt", "hello");
      await storage.mkdir(`${root}/docs/empty`);
      const entries = await storage.list(`${root}/docs`);
      expect(entries.map((entry) => entry.name).sort()).toEqual(["a.txt", "empty"]);
      const file = entries.find((entry) => entry.name === "a.txt");
      expect(file).toMatchObject({
        kind: "file",
        size: 5,
        ext: ".txt",
        path: `${root}/docs/a.txt`,
      });
      expect(file?.modifiedAt).toBeInstanceOf(Date);
      expect(entries.find((entry) => entry.name === "empty")).toMatchObject({
        kind: "dir",
        ext: "",
      });
    });

    it("fails to list a file and reports a missing path as not_found", async () => {
      const file = await seed("f.txt", "x");
      expect(await kindOf(storage.list(file))).toBe("bad_request");
      expect(await kindOf(storage.list(`${root}/missing`))).toBe("not_found");
    });

    it("stats files and directories as entries, and statFile refuses a directory", async () => {
      const file = await seed("s/F.txt", "12345");
      const stat = await storage.stat(file);
      expect(stat).toMatchObject({
        path: file,
        name: "F.txt",
        kind: "file",
        size: 5,
        ext: ".txt",
      });
      expect(stat.modifiedAt).toBeInstanceOf(Date);
      expect(stat.ino).toBeTypeOf("bigint");
      expect(await storage.statFile(file)).toEqual(stat);
      const dir = await storage.stat(`${root}/s`);
      expect(dir).toMatchObject({ path: `${root}/s`, name: "s", kind: "dir", ext: "" });
      expect(dir.modifiedAt).toBeInstanceOf(Date);
      expect(await kindOf(storage.statFile(`${root}/s`))).toBe("bad_request");
      expect(await kindOf(storage.statFile(`${root}/nope`))).toBe("not_found");
      expect(await kindOf(storage.stat(`${root}/nope`))).toBe("not_found");
    });

    it("opens a file with its size and modification time, to stream or read by position", async () => {
      const file = await seed("d.txt", "hello world");
      const { modifiedAt } = await storage.stat(file);
      const whole = await storage.open(file);
      expect(whole).toMatchObject({ size: 11, modifiedAt });
      expect(new TextDecoder().decode(await whole.read(6, 100))).toBe("world");
      expect(await whole.read(11, 1)).toHaveLength(0);
      expect(await text(whole.stream())).toBe("hello world");
      expect(await text((await storage.open(file)).stream(6, 10))).toBe("world");
      expect(await text((await storage.open(file)).stream(6))).toBe("world");
      expect(await text((await storage.open(file)).stream(6, 3))).toBe("");
      expect(await kindOf(storage.open(`${root}/nope`))).toBe("not_found");
      expect(await kindOf(storage.open(root))).toBe("bad_request");
    });

    it("closes a file once its stream ends or is cancelled, and closes it once", async () => {
      const path = await seed("c.txt", "hello");
      const ended = await storage.open(path);
      await text(ended.stream());
      expect(await kindOf(ended.read(0, 1))).toBe("internal");
      const cancelled = await storage.open(path);
      await cancelled.stream().cancel();
      expect(await kindOf(cancelled.read(0, 1))).toBe("internal");
      const closed = await storage.open(path);
      await closed.close();
      await closed.close();
      expect(await kindOf(closed.read(0, 1))).toBe("internal");
    });

    it("uploads with parents, replaces when asked, keeps the given mtime and reports the file", async () => {
      const path = `${root}/deep/er/file.txt`;
      const first = await storage.upload(path, new TextEncoder().encode("one"), {
        mkdirParents: true,
      });
      expect(first).toMatchObject({ path, name: "file.txt", kind: "file", size: 3, ext: ".txt" });
      expect(first).toEqual(await storage.stat(path));
      expect(await text((await storage.open(path)).stream())).toBe("one");
      const at = new Date("2020-01-02T03:04:05Z");
      const second = await storage.upload(path, new TextEncoder().encode("three"), {
        modifiedAt: at,
        overwrite: true,
      });
      expect(second).toMatchObject({ path, size: 5, modifiedAt: at });
      expect(second).toEqual(await storage.stat(path));
      expect(await text((await storage.open(path)).stream())).toBe("three");
      expect(
        await kindOf(storage.upload(`${root}/short.txt`, new Uint8Array(2), { contentLength: 3 })),
      ).toBe("bad_request");
      expect(await kindOf(storage.stat(`${root}/short.txt`))).toBe("not_found");
    });

    it("publishes an upload sent in pieces at the last, and takes a piece sent again", async () => {
      const path = `${root}/pieces/file.txt`;
      const encode = (value: string) => new TextEncoder().encode(value);
      const part = (offset: number) => ({ part: { id: "0123456789abcdef", offset } });
      await storage.uploadPart(path, encode("hello"), part(0));
      await storage.uploadPart(path, encode(" WORLD!"), part(5));
      expect(await kindOf(storage.statFile(path))).toBe("not_found");
      // Sent again from its offset, a piece replaces what the last attempt left.
      const published = await storage.upload(path, encode(" world"), {
        ...part(5),
        mkdirParents: true,
      });
      expect(published).toMatchObject({ path, size: 11 });
      expect(await text((await storage.open(path)).stream())).toBe("hello world");
      expect((await storage.list(`${root}/pieces`)).map((entry) => entry.name)).toEqual([
        "file.txt",
      ]);
      expect(await kindOf(storage.uploadPart(path, encode("x"), part(0)))).toBe("conflict");
    });

    it("stages an upload's body outside the caller's critical section and publishes inside it", async () => {
      let inside = 0;
      /** How many critical sections were open each time the body was read. */
      const openWhileStaging: number[] = [];
      const seen: (string | null)[] = [];
      const entered: number[] = [];
      const path = `${root}/staged/deep/file.txt`;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          openWhileStaging.push(inside);
          seen.push(await kindOf(storage.stat(path)));
          controller.enqueue(new TextEncoder().encode("staged"));
          controller.close();
        },
      });
      await storage.upload(path, body, {
        mkdirParents: true,
        critical: async (work) => {
          inside++;
          entered.push(openWhileStaging.length);
          const result = await work();
          inside--;
          return result;
        },
      });
      expect(openWhileStaging).toEqual([0]);
      // Nothing is at the path while the body arrives, and it is published last.
      expect(seen).toEqual(["not_found"]);
      expect(entered.at(-1)).toBe(1);
      expect(await text((await storage.open(path)).stream())).toBe("staged");
    });

    it("creates directories, with parents on request, and reports the first it created", async () => {
      expect(await storage.mkdir(`${root}/one`)).toMatchObject({
        path: `${root}/one`,
        name: "one",
        kind: "dir",
        created: `${root}/one`,
      });
      const made = await storage.mkdir(`${root}/two/three`, { parents: true });
      expect(made).toMatchObject({ path: `${root}/two/three`, created: `${root}/two` });
      expect(made.ino).toBe((await storage.stat(`${root}/two/three`)).ino);
      expect(await storage.mkdir(`${root}/two/three`, { parents: true })).toMatchObject({
        path: `${root}/two/three`,
        created: null,
      });
      expect(await kindOf(storage.mkdir(`${root}/one`))).toBe("conflict");
      expect(await kindOf(storage.mkdir(`${root}/none/four`))).toBe("not_found");
    });

    it("moves files and whole directories, keeping their inodes, and reports where they went", async () => {
      const file = await seed("m/a.txt", "a");
      await seed("m/sub/b.txt", "b");
      const { ino } = await storage.stat(file);
      const renamed = await storage.move(file, `${root}/m/renamed.txt`);
      expect(renamed).toMatchObject({ path: `${root}/m/renamed.txt`, kind: "file", size: 1, ino });
      expect(renamed).toEqual(await storage.stat(`${root}/m/renamed.txt`));
      expect(await kindOf(storage.statFile(file))).toBe("not_found");
      expect(await text((await storage.open(`${root}/m/renamed.txt`)).stream())).toBe("a");
      const folder = await storage.move(`${root}/m`, `${root}/moved`);
      expect(folder).toMatchObject({ path: `${root}/moved`, name: "moved", kind: "dir" });
      expect(await kindOf(storage.stat(`${root}/m`))).toBe("not_found");
      expect(await text((await storage.open(`${root}/moved/sub/b.txt`)).stream())).toBe("b");
      expect(await kindOf(storage.move(`${root}/nope`, `${root}/x`))).toBe("not_found");
    });

    for (const overwrite of [undefined, false] as const) {
      it(`refuses a taken target for move, copy and upload with overwrite ${overwrite}`, async () => {
        const source = await seed("o/src.txt", "new");
        const target = await seed("o/dst.txt", "old");
        const folder = `${root}/o/folder`;
        await storage.mkdir(folder);
        const opts = overwrite === undefined ? undefined : { overwrite };
        expect(await kindOf(storage.move(source, target, opts))).toBe("conflict");
        expect(await kindOf(storage.copy(source, target, opts))).toBe("conflict");
        expect(await kindOf(storage.move(folder, target, opts))).toBe("conflict");
        expect(await kindOf(storage.copy(source, folder, opts))).toBe("conflict");
        expect(await kindOf(storage.upload(target, new TextEncoder().encode("newer"), opts))).toBe(
          "conflict",
        );
        expect(await text((await storage.open(target)).stream())).toBe("old");
        expect(await text((await storage.open(source)).stream())).toBe("new");
        expect(await storage.stat(folder)).toMatchObject({ kind: "dir" });
      });
    }

    it("replaces a taken file target for move, copy and upload with overwrite true", async () => {
      const target = await seed("r/dst.txt", "old");
      await storage.upload(target, new TextEncoder().encode("uploaded"), { overwrite: true });
      expect(await text((await storage.open(target)).stream())).toBe("uploaded");
      const copied = await seed("r/copied.txt", "copied");
      await storage.copy(copied, target, { overwrite: true });
      expect(await text((await storage.open(target)).stream())).toBe("copied");
      expect(await text((await storage.open(copied)).stream())).toBe("copied");
      const moved = await seed("r/moved.txt", "moved");
      await storage.move(moved, target, { overwrite: true });
      expect(await text((await storage.open(target)).stream())).toBe("moved");
      expect(await kindOf(storage.stat(moved))).toBe("not_found");
    });

    it("copies files and whole directories, leaving the source in place, and reports the copy", async () => {
      const file = await seed("c/a.txt", "a");
      await seed("c/sub/b.txt", "b");
      const copy = await storage.copy(file, `${root}/c/copy.txt`);
      expect(copy).toMatchObject({ path: `${root}/c/copy.txt`, kind: "file", size: 1 });
      expect(copy).toEqual(await storage.stat(`${root}/c/copy.txt`));
      expect(copy.ino).not.toBe((await storage.stat(file)).ino);
      expect(await text((await storage.open(file)).stream())).toBe("a");
      expect(await text((await storage.open(`${root}/c/copy.txt`)).stream())).toBe("a");
      expect(await storage.copy(`${root}/c`, `${root}/c2`)).toMatchObject({
        path: `${root}/c2`,
        kind: "dir",
      });
      expect(await text((await storage.open(`${root}/c/sub/b.txt`)).stream())).toBe("b");
      expect(await text((await storage.open(`${root}/c2/sub/b.txt`)).stream())).toBe("b");
    });

    it("deletes files and directories recursively", async () => {
      const file = await seed("del/a.txt", "a");
      await seed("del/sub/b.txt", "b");
      await storage.deleteFile(file);
      expect(await kindOf(storage.statFile(file))).toBe("not_found");
      expect(await kindOf(storage.deleteFile(file))).toBe("not_found");
      await storage.deleteDir(`${root}/del`);
      expect(await kindOf(storage.stat(`${root}/del`))).toBe("not_found");
      expect(await kindOf(storage.stat(`${root}/del/sub/b.txt`))).toBe("not_found");
    });

    it("deletes a directory only while it is empty", async () => {
      const file = await seed("e/full/a.txt", "a");
      await storage.mkdir(`${root}/e/nested/inner`, { parents: true });
      expect(await kindOf(storage.deleteEmptyDir(`${root}/e/full`))).toBe("conflict");
      expect(await kindOf(storage.deleteEmptyDir(`${root}/e/nested`))).toBe("conflict");
      expect(await kindOf(storage.deleteEmptyDir(file))).toBe("bad_request");
      expect(await text((await storage.open(file)).stream())).toBe("a");
      await storage.deleteEmptyDir(`${root}/e/nested/inner`);
      await storage.deleteEmptyDir(`${root}/e/nested`);
      expect(await kindOf(storage.stat(`${root}/e/nested`))).toBe("not_found");
      expect(await kindOf(storage.deleteEmptyDir(`${root}/e/nested`))).toBe("not_found");
    });

    it("keeps Unicode and literal-percent names intact", async () => {
      const name = "ünï cødé %41 😀.txt";
      const path = await seed(name, "u");
      const entries = await storage.list(root);
      expect(entries.map((entry) => entry.name)).toContain(name);
      expect(await text((await storage.open(path)).stream())).toBe("u");
      await storage.move(path, `${root}/${name}.moved`);
      expect((await storage.list(root)).map((entry) => entry.name)).toContain(`${name}.moved`);
    });

    it("zips files and folders with everything in them, empty folders included", async () => {
      const file = await seed("z/a.txt", "zip me");
      await seed("z/docs/b.txt", "and me");
      await storage.mkdir(`${root}/z/docs/empty`);
      const steps: ZipProgress[] = [];
      const stream = await storage.zip([`${root}/z/docs`, file], {
        onProgress: (step) => steps.push(step),
      });
      expect(unzip(new Uint8Array(await new Response(stream).arrayBuffer()))).toEqual({
        "docs/b.txt": "and me",
        "docs/empty/": "",
        "a.txt": "zip me",
      });
      expect(steps[0]).toEqual({ processed: 0, total: 2, bytes: 0 });
      expect(steps.at(-1)).toEqual({ processed: 2, total: 2, bytes: 12 });
      expect(await kindOf(storage.zip([`${root}/z/nope`]))).toBe("not_found");
      const aborted = new AbortController();
      aborted.abort();
      await expect(storage.zip([file], { signal: aborted.signal })).rejects.toThrow();
    });

    it("leaves a folder holding the skip name out of a zip, with everything in it", async () => {
      await seed("s/keep.txt", "keep");
      await seed("s/vault/.skip-me", "marker");
      await seed("s/vault/inner/secret.txt", "secret");
      await seed("s/other/.skip-me/x.txt", "a folder by that name does not count");
      const stream = await storage.zip([`${root}/s`], { skipFoldersWith: ".skip-me" });
      expect(unzip(new Uint8Array(await new Response(stream).arrayBuffer()))).toEqual({
        "s/keep.txt": "keep",
        "s/other/.skip-me/x.txt": "a folder by that name does not count",
      });
    });

    it("zips the root as its contents", async () => {
      await seed("r.txt", "root");
      const stream = await storage.zip(["/"]);
      const names = Object.keys(unzip(new Uint8Array(await new Response(stream).arrayBuffer())));
      expect(names).toContain(`${root.slice(1)}/r.txt`);
    });

    it("probes a directory for read access", async () => {
      const file = await seed("p/a.txt", "p");
      await expect(storage.probeDirectoryRead(`${root}/p`)).resolves.toBeUndefined();
      expect(await kindOf(storage.probeDirectoryRead(`${root}/nope`))).toBe("not_found");
      expect(await kindOf(storage.probeDirectoryRead(file))).toBe("bad_request");
    });

    it("stamps a file without reading it: a rewrite is a new inode, a rename keeps it", async () => {
      const file = await seed("st/a.txt", "stamp");
      const stamp = await storage.contentStamp(file);
      expect(stamp).toMatchObject({ size: 5, ino: (await storage.stat(file)).ino });
      expect(await storage.contentStamp(file)).toEqual(stamp);
      const at = new Date("2022-03-04T05:06:07Z");
      await storage.upload(file, new TextEncoder().encode("again"), {
        overwrite: true,
        modifiedAt: at,
      });
      const rewritten = await storage.contentStamp(file);
      expect(rewritten.ino).not.toBe(stamp.ino);
      expect(rewritten.mtimeNs).toBe(BigInt(at.getTime()) * BigInt(1_000_000));
      await storage.move(file, `${root}/st/b.txt`);
      expect((await storage.contentStamp(`${root}/st/b.txt`)).ino).toBe(rewritten.ino);
      expect(await kindOf(storage.contentStamp(`${root}/st`))).toBe("bad_request");
      expect(await kindOf(storage.contentStamp(file))).toBe("not_found");
    });
  });
}
