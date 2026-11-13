import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bytes,
  type Fixture,
  fixture,
  kindOf,
  read,
  streamOf,
  zipEntries,
} from "../test/helpers.js";

let f: Fixture;

beforeEach(async () => {
  f = await fixture();
});

afterEach(async () => {
  await f.cleanup();
});

/** The storage's zip, which local storage always has. */
function zip(paths: readonly string[], opts?: { signal?: AbortSignal }) {
  if (f.storage.zip === undefined) throw new Error("local storage has no zip");
  return f.storage.zip(paths, opts);
}

/** Creates the home and returns its path, for tests that arrange files directly. */
async function home(): Promise<string> {
  await f.storage.list("/");
  return f.home;
}

describe("home folder", () => {
  it("is created on first use and starts empty", async () => {
    expect(await f.storage.list("/")).toEqual([]);
    expect((await stat(f.home)).isDirectory()).toBe(true);
  });

  it("tries again after a failed creation instead of remembering it", async () => {
    await writeFile(f.home, "in the way");
    expect(await kindOf(f.storage.list("/"))).toBe("conflict");
    await rm(f.home);
    expect(await f.storage.list("/")).toEqual([]);
  });

  it("clamps .. at the home", async () => {
    await f.storage.upload("/../../escape.txt", bytes("x"));
    expect(await readFile(join(f.home, "escape.txt"), "utf8")).toBe("x");
    expect(await readdir(f.root)).toEqual(["alice"]);
  });

  it("refuses a path with a NUL byte as a bad request", async () => {
    expect(await kindOf(f.storage.stat("/a\0b"))).toBe("bad_request");
  });

  it("reports a home removed from under it as not found", async () => {
    await home();
    await rm(f.home, { recursive: true });
    expect(await kindOf(f.storage.stat("/a/b"))).toBe("not_found");
  });
});

describe("symlinks", () => {
  let outside: string;

  beforeEach(async () => {
    outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(await home(), "out"));
  });

  it("lists a link that leaves the home as a symlink and refuses to follow it", async () => {
    expect(await f.storage.list("/")).toMatchObject([{ name: "out", kind: "symlink", size: 0 }]);
    expect(await kindOf(f.storage.list("/out"))).toBe("forbidden");
    expect(await kindOf(f.storage.stat("/out"))).toBe("forbidden");
    expect(await kindOf(f.storage.download("/out/secret.txt"))).toBe("forbidden");
    expect(await kindOf(f.storage.upload("/out/new.txt", bytes("x")))).toBe("forbidden");
    expect(await kindOf(f.storage.mkdir("/out/dir"))).toBe("forbidden");
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  it("refuses a file link that leaves the home", async () => {
    await symlink(join(outside, "secret.txt"), join(f.home, "secret.txt"));
    expect(await kindOf(f.storage.download("/secret.txt"))).toBe("forbidden");
  });

  it("deletes a link itself, never what it points at", async () => {
    await f.storage.deleteFile("/out");
    expect(await f.storage.list("/")).toEqual([]);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("follows links that stay inside the home", async () => {
    await f.storage.upload("/real/a.txt", bytes("a"), { mkdirParents: true });
    await symlink(join(f.home, "real"), join(f.home, "alias"));
    await symlink(join(f.home, "real", "a.txt"), join(f.home, "a-link.txt"));
    const entries = await f.storage.list("/");
    expect(entries.find((entry) => entry.name === "alias")).toMatchObject({ kind: "dir" });
    expect(entries.find((entry) => entry.name === "a-link.txt")).toMatchObject({
      kind: "file",
      size: 1,
    });
    expect(await read(f.storage, "/alias/a.txt")).toBe("a");
    expect(await read(f.storage, "/a-link.txt")).toBe("a");
    expect(await f.storage.list("/alias")).toMatchObject([{ path: "/alias/a.txt" }]);
    // A path through links is spelled as asked: the link's own name, not its target's.
    expect(await f.storage.stat("/alias/a.txt")).not.toHaveProperty("path");
    expect(await f.storage.stat("/a-link.txt")).not.toHaveProperty("path");
    expect(await f.storage.stat("/real/a.txt")).not.toHaveProperty("path");
  });

  it("lists a dangling link as a symlink and reports it missing", async () => {
    await symlink(join(f.root, "nowhere"), join(f.home, "dangling"));
    const entries = await f.storage.list("/");
    expect(entries.find((entry) => entry.name === "dangling")).toMatchObject({ kind: "symlink" });
    expect(await kindOf(f.storage.stat("/dangling"))).toBe("not_found");
  });
});

describe("upload", () => {
  it("publishes nothing when the body fails midway", async () => {
    await f.storage.upload("/f.txt", bytes("old"));
    const failed = f.storage.upload("/f.txt", streamOf(["new"], new Error("client went away")));
    await expect(failed).rejects.toThrow();
    await f.storage.upload("/g.txt", streamOf(["x"], new Error("gone"))).catch(() => undefined);
    expect(await read(f.storage, "/f.txt")).toBe("old");
    expect(await readdir(f.home)).toEqual(["f.txt"]);
  });

  it("refuses a body shorter than its declared length", async () => {
    expect(await kindOf(f.storage.upload("/f.txt", bytes("abc"), { contentLength: 5 }))).toBe(
      "bad_request",
    );
    expect(await readdir(f.home)).toEqual([]);
  });

  it("writes a streamed body with its modification time and a signal", async () => {
    const at = new Date("2019-03-04T05:06:07Z");
    const signal = new AbortController().signal;
    await f.storage.upload("/s.txt", streamOf(["he", "llo"]), {
      modifiedAt: at,
      contentLength: 5,
      signal,
    });
    await f.storage.upload("/b.txt", bytes("b"), { signal });
    expect(await read(f.storage, "/s.txt")).toBe("hello");
    expect((await f.storage.statFile("/s.txt")).modifiedAt?.getTime()).toBe(at.getTime());
  });

  it("stops on an aborted signal and leaves nothing behind", async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      f.storage.upload("/a.txt", bytes("a"), { signal: before.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const during = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("first"));
      },
      pull() {
        during.abort();
      },
    });
    await expect(f.storage.upload("/b.txt", body, { signal: during.signal })).rejects.toMatchObject(
      { name: "AbortError" },
    );
    expect(await readdir(f.home)).toEqual([]);
  });

  it("uses a fallback abort reason for a signal without one", async () => {
    const signal = { aborted: true, reason: undefined } as unknown as AbortSignal;
    await expect(f.storage.upload("/a.txt", bytes("a"), { signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("creates only when the name is free, even under a race", async () => {
    await f.storage.upload("/taken.txt", bytes("old"));
    expect(await kindOf(f.storage.upload("/taken.txt", bytes("new"), { overwrite: false }))).toBe(
      "conflict",
    );
    expect(await read(f.storage, "/taken.txt")).toBe("old");

    const results = await Promise.allSettled(
      ["one", "two", "three"].map((value) =>
        f.storage.upload("/race.txt", bytes(value), { overwrite: false }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(["one", "two", "three"]).toContain(await read(f.storage, "/race.txt"));
    expect((await readdir(f.home)).sort()).toEqual(["race.txt", "taken.txt"]);
  });

  it("refuses a folder or the home as a target", async () => {
    await f.storage.mkdir("/dir");
    expect(await kindOf(f.storage.upload("/dir", bytes("x")))).toBe("conflict");
    expect(await kindOf(f.storage.upload("/", bytes("x")))).toBe("conflict");
  });

  it("needs the parent folder unless asked to create it", async () => {
    expect(await kindOf(f.storage.upload("/no/such/file.txt", bytes("x")))).toBe("not_found");
  });

  it("hides unfinished uploads from listings but not other dotfiles", async () => {
    await writeFile(join(await home(), ".fdrive-partial-0123456789abcdef"), "half");
    await writeFile(join(f.home, ".env"), "x");
    expect((await f.storage.list("/")).map((entry) => entry.name)).toEqual([".env"]);
  });
});

describe("download", () => {
  beforeEach(async () => {
    await f.storage.upload("/d.txt", bytes("hello world"));
  });

  it("sends the whole file for a range it cannot satisfy", async () => {
    const past = await f.storage.download("/d.txt", { range: { start: 50 } });
    expect(past.status).toBe(200);
    const inverted = await f.storage.download("/d.txt", { range: { start: 5, end: 2 } });
    expect(inverted.status).toBe(200);
    expect(await new Response(inverted.body).text()).toBe("hello world");
  });

  it("applies a range only while If-Range names the current version", async () => {
    const mtime = (await f.storage.statFile("/d.txt")).modifiedAt as Date;
    const range = { start: 6 };
    const same = await f.storage.download("/d.txt", { range, ifRange: mtime.toUTCString() });
    expect(same.status).toBe(206);
    expect(await new Response(same.body).text()).toBe("world");
    for (const ifRange of ["Mon, 01 Jan 2001 00:00:00 GMT", '"etag"', 'W/"etag"', "garbage"]) {
      expect((await f.storage.download("/d.txt", { range, ifRange })).status).toBe(200);
    }
  });

  it("sends an empty file", async () => {
    await f.storage.upload("/empty", bytes(""));
    const result = await f.storage.download("/empty", { range: { start: 0 } });
    expect(result).toMatchObject({ status: 200, contentLength: 0 });
    expect(await new Response(result.body).text()).toBe("");
  });

  it("refuses folders and special files without hanging", async () => {
    await f.storage.mkdir("/dir");
    execFileSync("mkfifo", [join(f.home, "pipe")]);
    expect(await kindOf(f.storage.download("/dir"))).toBe("bad_request");
    expect(await kindOf(f.storage.download("/pipe"))).toBe("bad_request");
    expect(await f.storage.stat("/pipe")).toMatchObject({ kind: "other", size: 0 });
    expect((await f.storage.list("/")).find((entry) => entry.name === "pipe")).toMatchObject({
      kind: "other",
    });
    expect(await kindOf(f.storage.statFile("/pipe"))).toBe("bad_request");
  });

  it("stops the body when the signal aborts", async () => {
    await f.storage.upload("/big.bin", new Uint8Array(4 * 1024 * 1024));
    const controller = new AbortController();
    const result = await f.storage.download("/big.bin", { signal: controller.signal });
    controller.abort();
    await expect(new Response(result.body).arrayBuffer()).rejects.toThrow();
  });
});

describe("mkdir", () => {
  it("refuses an existing name unless creating parents", async () => {
    await f.storage.mkdir("/a");
    expect(await kindOf(f.storage.mkdir("/a"))).toBe("conflict");
    await f.storage.mkdir("/a", { parents: true });
    await f.storage.upload("/f.txt", bytes("x"));
    expect(await kindOf(f.storage.mkdir("/f.txt", { parents: true }))).toBe("conflict");
    expect(await kindOf(f.storage.mkdir("/f.txt/sub"))).toBe("not_found");
  });
});

describe("move", () => {
  it("replaces a folder only when asked to overwrite", async () => {
    await f.storage.upload("/a/x.txt", bytes("x"), { mkdirParents: true });
    await f.storage.upload("/b/y.txt", bytes("y"), { mkdirParents: true });
    expect(await kindOf(f.storage.move("/a", "/b"))).toBe("conflict");
    await f.storage.move("/a", "/b", { overwrite: true });
    expect((await f.storage.list("/b")).map((entry) => entry.name)).toEqual(["x.txt"]);
  });

  it("replaces a file in one step when asked to overwrite", async () => {
    await f.storage.upload("/new.txt", bytes("new"));
    await f.storage.upload("/old.txt", bytes("old"));
    await f.storage.move("/new.txt", "/old.txt", { overwrite: true });
    expect(await read(f.storage, "/old.txt")).toBe("new");
    expect(await kindOf(f.storage.stat("/new.txt"))).toBe("not_found");
  });

  it("refuses moving a folder into itself or the home anywhere", async () => {
    await f.storage.mkdir("/a");
    expect(await kindOf(f.storage.move("/a", "/a/b/c"))).toBe("bad_request");
    expect(await readdir(join(f.home, "a"))).toEqual([]);
    expect(await kindOf(f.storage.move("/", "/elsewhere"))).toBe("not_found");
  });

  it("creates missing parents of the target and treats a move onto itself as done", async () => {
    await f.storage.upload("/f.txt", bytes("f"));
    await f.storage.move("/f.txt", "/f.txt");
    await f.storage.move("/f.txt", "/deep/er/f.txt");
    expect(await read(f.storage, "/deep/er/f.txt")).toBe("f");
  });
});

describe("copy", () => {
  it("keeps the modification time and refuses a taken name when asked", async () => {
    const at = new Date("2018-01-01T00:00:00Z");
    await f.storage.upload("/a.txt", bytes("a"), { modifiedAt: at });
    await f.storage.copy("/a.txt", "/b.txt");
    expect((await f.storage.statFile("/b.txt")).modifiedAt?.getTime()).toBe(at.getTime());
    expect(await kindOf(f.storage.copy("/a.txt", "/b.txt", { overwrite: false }))).toBe("conflict");
  });

  it("refuses the home, a copy onto itself and a folder into itself", async () => {
    await f.storage.upload("/d/f.txt", bytes("f"), { mkdirParents: true });
    expect(await kindOf(f.storage.copy("/", "/x"))).toBe("not_found");
    expect(await kindOf(f.storage.copy("/d/f.txt", "/d/f.txt"))).toBe("bad_request");
    expect(await kindOf(f.storage.copy("/d", "/d/inner"))).toBe("bad_request");
  });

  it("replaces a target of the other kind", async () => {
    await f.storage.upload("/file.txt", bytes("file"));
    await f.storage.upload("/dir/inner.txt", bytes("inner"), { mkdirParents: true });
    await f.storage.mkdir("/as-dir");
    await f.storage.upload("/as-file", bytes("x"));
    await f.storage.copy("/file.txt", "/as-dir");
    await f.storage.copy("/dir", "/as-file");
    expect(await read(f.storage, "/as-dir")).toBe("file");
    expect(await read(f.storage, "/as-file/inner.txt")).toBe("inner");
  });

  it("merges into an existing folder and skips unfinished uploads", async () => {
    await f.storage.upload("/src/a.txt", bytes("a"), { mkdirParents: true });
    await writeFile(join(f.home, "src", ".fdrive-partial-0123456789abcdef"), "half");
    await f.storage.upload("/dst/b.txt", bytes("b"), { mkdirParents: true });
    await f.storage.copy("/src", "/dst");
    expect((await readdir(join(f.home, "dst"))).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("refuses a special file", async () => {
    execFileSync("mkfifo", [join(await home(), "pipe")]);
    expect(await kindOf(f.storage.copy("/pipe", "/copy"))).toBe("bad_request");
  });
});

describe("delete", () => {
  it("checks the kind it is asked to delete", async () => {
    await f.storage.mkdir("/dir");
    await f.storage.upload("/f.txt", bytes("f"));
    expect(await kindOf(f.storage.deleteFile("/dir"))).toBe("bad_request");
    expect(await kindOf(f.storage.deleteDir("/f.txt"))).toBe("bad_request");
  });

  it("empties the home when deleting it, keeping the folder", async () => {
    await f.storage.upload("/a/b.txt", bytes("b"), { mkdirParents: true });
    await f.storage.upload("/c.txt", bytes("c"));
    await f.storage.deleteDir("/");
    expect(await readdir(f.home)).toEqual([]);
  });
});

describe("probeDirectoryRead", () => {
  it("refuses a file", async () => {
    await f.storage.upload("/f.txt", bytes("f"));
    expect(await kindOf(f.storage.probeDirectoryRead?.("/f.txt") ?? Promise.resolve())).toBe(
      "bad_request",
    );
  });
});

describe("setModifiedAt", () => {
  it("sets a folder's time too", async () => {
    await f.storage.mkdir("/dir");
    const at = new Date("2017-07-07T07:07:07Z");
    await f.storage.setModifiedAt?.("/dir", at);
    expect((await lstat(join(f.home, "dir"))).mtime.getTime()).toBe(at.getTime());
  });
});

describe("zip", () => {
  it("includes files and empty folders, stores compressed formats and skips links", async () => {
    await f.storage.upload("/album/a.txt", bytes("text"), { mkdirParents: true });
    await f.storage.upload("/album/b.jpg", bytes("jpeg"));
    await f.storage.mkdir("/album/empty");
    await writeFile(join(f.home, "album", ".fdrive-partial-0123456789abcdef"), "half");
    await symlink(join(f.home, "album", "a.txt"), join(f.home, "album", "link.txt"));
    const entries = await zipEntries(await zip(["/album"]));
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: "album/a.txt", method: 8 },
        { name: "album/b.jpg", method: 0 },
        { name: "album/empty/", method: 0 },
      ]),
    );
    expect(entries).toHaveLength(3);
  });

  it("puts the home's children at the top and skips special files", async () => {
    await f.storage.upload("/top.txt", bytes("t"));
    await f.storage.upload("/photo.png", bytes("p"));
    execFileSync("mkfifo", [join(f.home, "pipe")]);
    const entries = await zipEntries(await zip(["/", "/photo.png", "/pipe"]));
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "photo.png",
      "photo.png",
      "top.txt",
    ]);
  });

  it("makes an empty archive of an empty home", async () => {
    expect(await zipEntries(await zip(["/"]))).toEqual([]);
  });

  it("refuses a missing path and an aborted signal", async () => {
    expect(await kindOf(zip(["/missing"]))).toBe("not_found");
    const controller = new AbortController();
    controller.abort();
    await expect(zip(["/"], { signal: controller.signal })).rejects.toThrow();
  });

  it("stops the stream when the signal aborts", async () => {
    await f.storage.upload("/big.bin", new Uint8Array(4 * 1024 * 1024));
    const controller = new AbortController();
    const body = await zip(["/big.bin"], { signal: controller.signal });
    controller.abort();
    await expect(new Response(body).arrayBuffer()).rejects.toThrow();
  });

  it("fails the stream, not the process, when a file changes while zipping", async () => {
    // Stored, not deflated, so backpressure stops the read long before the end.
    await f.storage.upload("/big.jpg", new Uint8Array(4 * 1024 * 1024));
    const body = await zip(["/big.jpg"]);
    // Let yazl stat the file before it shrinks under the open archive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await truncate(join(f.home, "big.jpg"), 0);
    await expect(new Response(body).arrayBuffer()).rejects.toThrow();
  });
});
