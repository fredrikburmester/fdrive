import { isStorageError, type StorageProvider } from "@fdrive/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export interface StorageConformanceOptions {
  /**
   * Whether the provider's `move` and `copy` overwrite an existing target
   * by default (SFTPGo does) rather than refusing it with `conflict`.
   */
  readonly overwritesOnMove?: boolean;
  /**
   * A directory the suite may create everything under, when the provider
   * cannot offer a clean root per test (a shared real server). Defaults to
   * a unique directory under "/".
   */
  readonly workspace?: string;
  /** Skips checks that need `probeDirectoryRead`; it is optional on the port. */
  readonly probe?: boolean;
}

export interface StorageFactoryResult {
  readonly storage: StorageProvider;
  /** Called after each test; tear down anything the factory allocated. */
  cleanup?(): Promise<void>;
}

/** Builds a fresh, empty (or at least isolated) storage for one test. */
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
 * The behavioural contract every `StorageProvider` implementation must
 * pass. Run it against a provider's fake in its unit tests and against the
 * real backend in its integration tests; the memory storage in this package
 * passes it too, so anything tested on the fake holds for real providers.
 *
 * The suite creates everything it needs under a workspace directory and
 * removes it afterwards, so a shared backend can host many runs.
 */
export function describeStorageProvider(
  name: string,
  factory: StorageFactory,
  options: StorageConformanceOptions = {},
): void {
  const overwrites = options.overwritesOnMove ?? false;

  describe(`StorageProvider conformance: ${name}`, () => {
    let storage: StorageProvider;
    let cleanup: (() => Promise<void>) | undefined;
    let root: string;

    beforeEach(async () => {
      const result = await factory();
      storage = result.storage;
      cleanup = result.cleanup?.bind(result);
      root =
        options.workspace ??
        `/conformance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await storage.mkdir(root, { parents: true });
    });

    afterEach(async () => {
      try {
        await storage.deleteDir(root);
      } catch {
        // A test may already have removed it.
      }
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
      // Listing a file is always an error, but a real SFTPGo 2.7.5 drops the
      // connection instead of answering, which surfaces as
      // `upstream_unavailable`; fakes and other providers say `bad_request`.
      expect(["bad_request", "upstream_unavailable"]).toContain(await kindOf(storage.list(file)));
      expect(await kindOf(storage.list(`${root}/missing`))).toBe("not_found");
    });

    it("stats files and directories, and statFile refuses a directory", async () => {
      const file = await seed("s/f.txt", "12345");
      expect(await storage.statFile(file)).toMatchObject({ size: 5 });
      expect(await storage.stat(file)).toMatchObject({ kind: "file", size: 5 });
      expect(await storage.stat(`${root}/s`)).toMatchObject({ kind: "dir" });
      expect(await kindOf(storage.statFile(`${root}/s`))).toBe("bad_request");
      expect(await kindOf(storage.statFile(`${root}/nope`))).toBe("not_found");
      expect(await kindOf(storage.stat(`${root}/nope`))).toBe("not_found");
    });

    it("downloads whole files and byte ranges", async () => {
      const file = await seed("d.txt", "hello world");
      const whole = await storage.download(file);
      expect(whole.status).toBe(200);
      expect(await text(whole.body)).toBe("hello world");
      const range = await storage.download(file, { range: { start: 6, end: 10 } });
      expect(range.status).toBe(206);
      expect(await text(range.body)).toBe("world");
      expect(range.contentRange).toBe("bytes 6-10/11");
      const open = await storage.download(file, { range: { start: 6 } });
      expect(await text(open.body)).toBe("world");
      expect(await kindOf(storage.download(`${root}/nope`))).toBe("not_found");
    });

    it("cancels a download through its signal", async () => {
      const file = await seed("c.txt", "hello");
      const controller = new AbortController();
      controller.abort();
      await expect(storage.download(file, { signal: controller.signal })).rejects.toThrow();
    });

    it("uploads with parents, overwrites, and keeps the given mtime when supported", async () => {
      const path = `${root}/deep/er/file.txt`;
      await storage.upload(path, new TextEncoder().encode("one"), { mkdirParents: true });
      expect(await text((await storage.download(path)).body)).toBe("one");
      const at = new Date("2020-01-02T03:04:05Z");
      await storage.upload(path, new TextEncoder().encode("two"), { modifiedAt: at });
      expect(await text((await storage.download(path)).body)).toBe("two");
      if (storage.setModifiedAt !== undefined) {
        expect((await storage.statFile(path)).modifiedAt?.getTime()).toBe(at.getTime());
      }
    });

    it("creates directories, with parents on request", async () => {
      await storage.mkdir(`${root}/one`);
      await storage.mkdir(`${root}/two/three`, { parents: true });
      expect(await storage.stat(`${root}/one`)).toMatchObject({ kind: "dir" });
      expect(await storage.stat(`${root}/two/three`)).toMatchObject({ kind: "dir" });
    });

    it("moves files and whole directories", async () => {
      const file = await seed("m/a.txt", "a");
      await seed("m/sub/b.txt", "b");
      await storage.move(file, `${root}/m/renamed.txt`);
      expect(await kindOf(storage.statFile(file))).toBe("not_found");
      expect(await text((await storage.download(`${root}/m/renamed.txt`)).body)).toBe("a");
      await storage.move(`${root}/m`, `${root}/moved`);
      expect(await kindOf(storage.stat(`${root}/m`))).toBe("not_found");
      expect(await text((await storage.download(`${root}/moved/sub/b.txt`)).body)).toBe("b");
      expect(await kindOf(storage.move(`${root}/nope`, `${root}/x`))).toBe("not_found");
    });

    it(`move onto an existing target ${overwrites ? "overwrites" : "conflicts"}`, async () => {
      const source = await seed("o/src.txt", "new");
      const target = await seed("o/dst.txt", "old");
      const kind = await kindOf(storage.move(source, target));
      if (overwrites) {
        expect(kind).toBeNull();
        expect(await text((await storage.download(target)).body)).toBe("new");
      } else {
        expect(kind).toBe("conflict");
        expect(await text((await storage.download(target)).body)).toBe("old");
      }
    });

    it("copies files and whole directories, leaving the source in place", async () => {
      const file = await seed("c/a.txt", "a");
      await seed("c/sub/b.txt", "b");
      await storage.copy(file, `${root}/c/copy.txt`);
      expect(await text((await storage.download(file)).body)).toBe("a");
      expect(await text((await storage.download(`${root}/c/copy.txt`)).body)).toBe("a");
      await storage.copy(`${root}/c`, `${root}/c2`);
      expect(await text((await storage.download(`${root}/c/sub/b.txt`)).body)).toBe("b");
      expect(await text((await storage.download(`${root}/c2/sub/b.txt`)).body)).toBe("b");
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

    it("keeps Unicode and literal-percent names intact", async () => {
      const name = "ünï cødé %41 😀.txt";
      const path = await seed(name, "u");
      const entries = await storage.list(root);
      expect(entries.map((entry) => entry.name)).toContain(name);
      expect(await text((await storage.download(path)).body)).toBe("u");
      await storage.move(path, `${root}/${name}.moved`);
      expect((await storage.list(root)).map((entry) => entry.name)).toContain(`${name}.moved`);
    });

    it("sets a file's modification time when the capability is present", async () => {
      const file = await seed("t.txt", "t");
      const at = new Date("2021-05-06T07:08:09Z");
      if (storage.setModifiedAt === undefined) {
        return;
      }
      await storage.setModifiedAt(file, at);
      expect((await storage.statFile(file)).modifiedAt?.getTime()).toBe(at.getTime());
      expect(await kindOf(storage.setModifiedAt(`${root}/nope`, at))).toBe("not_found");
    });

    it("streams a zip when the capability is present", async () => {
      const file = await seed("z/a.txt", "zip me");
      if (storage.zip === undefined) {
        return;
      }
      const stream = await storage.zip([file]);
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      expect(bytes.length).toBeGreaterThan(4);
      expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
    });

    it("probes a directory for read access when the method is present", async () => {
      if (options.probe === false || storage.probeDirectoryRead === undefined) {
        return;
      }
      await seed("p/a.txt", "p");
      await expect(storage.probeDirectoryRead(`${root}/p`)).resolves.toBeUndefined();
      expect(await kindOf(storage.probeDirectoryRead(`${root}/nope`))).toBe("not_found");
    });
  });
}
