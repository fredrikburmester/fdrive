import { link, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytes, type Fixture, fixture, kindOf, read } from "../test/helpers.js";

// Records the order of flushes and publishes, which a test disk cannot show.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
  };
});

let f: Fixture;
let steps: string[];

beforeEach(async () => {
  f = await fixture();
  await f.storage.list("/");
  steps = [];
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      steps.push(`sync ${basename(String(args[0]))}`);
      await sync();
    };
    return handle;
  });
  vi.mocked(link).mockImplementation(async (from, to) => {
    steps.push(`link ${basename(String(from))} ${basename(String(to))}`);
    await actual.link(from, to);
  });
  vi.mocked(rename).mockImplementation(async (from, to) => {
    steps.push(`rename ${basename(String(from))} ${basename(String(to))}`);
    await actual.rename(from, to);
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await f.cleanup();
});

/** Steps with the random name of an upload's unfinished file replaced. */
const named = () => steps.map((step) => step.replace(/\.fdrive-partial-[0-9a-f]{16}/g, "partial"));

describe("durable uploads", () => {
  it("flush the file before publishing it and its folder after", async () => {
    await f.storage.upload("/dir/a.txt", bytes("a"), { mkdirParents: true, durable: true });
    expect(named()).toEqual(["sync partial", "link partial a.txt", "sync dir"]);
    steps.length = 0;
    await f.storage.upload("/dir/a.txt", bytes("b"), { overwrite: true, durable: true });
    expect(named()).toEqual(["sync partial", "rename partial a.txt", "sync dir"]);
    expect(await read(f.storage, "/dir/a.txt")).toBe("b");
  });

  it("flush nothing unless asked", async () => {
    await f.storage.upload("/a.txt", bytes("a"));
    expect(named()).toEqual(["link partial a.txt"]);
  });
});

describe("publishing moves", () => {
  it("link a staged file into place, then unlink it, and flush the folder", async () => {
    await f.storage.upload("/stage/s", bytes("staged"), { mkdirParents: true });
    const staged = (await f.storage.stat("/stage/s")).ino;
    steps.length = 0;
    await f.storage.move("/stage/s", "/docs/a.txt", { publish: true });
    expect(named()).toEqual(["link s a.txt", "sync docs"]);
    expect((await f.storage.stat("/docs/a.txt")).ino).toBe(staged);
    expect(await readdir(join(f.home, "stage"))).toEqual([]);
  });

  it("refuse a taken name, keeping both files", async () => {
    await f.storage.upload("/stage/s", bytes("staged"), { mkdirParents: true });
    await f.storage.upload("/a.txt", bytes("theirs"));
    expect(await kindOf(f.storage.move("/stage/s", "/a.txt", { publish: true }))).toBe("conflict");
    expect(await read(f.storage, "/a.txt")).toBe("theirs");
    expect(await read(f.storage, "/stage/s")).toBe("staged");
  });

  it("rename over the original when asked to overwrite", async () => {
    await f.storage.upload("/stage/s", bytes("new"), { mkdirParents: true });
    await f.storage.upload("/a.txt", bytes("old"));
    steps.length = 0;
    await f.storage.move("/stage/s", "/a.txt", { overwrite: true, publish: true });
    expect(named()).toEqual(["rename s a.txt", `sync ${basename(f.home)}`]);
    expect(await read(f.storage, "/a.txt")).toBe("new");
  });

  it("rename a staged folder into place only while the name is free", async () => {
    await f.storage.mkdir("/stage/new", { parents: true });
    await f.storage.mkdir("/taken");
    await f.storage.upload("/taken/x", bytes("x"));
    expect(await kindOf(f.storage.move("/stage/new", "/taken", { publish: true }))).toBe(
      "conflict",
    );
    const staged = (await f.storage.stat("/stage/new")).ino;
    steps.length = 0;
    await f.storage.move("/stage/new", "/folder", { publish: true });
    expect(named()).toEqual(["rename new folder", `sync ${basename(f.home)}`]);
    expect((await f.storage.stat("/folder")).ino).toBe(staged);
  });

  it("rename a file across filesystems, where no link reaches", async () => {
    await f.storage.upload("/stage/s", bytes("staged"), { mkdirParents: true });
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
    await f.storage.move("/stage/s", "/a.txt", { publish: true });
    expect(await read(f.storage, "/a.txt")).toBe("staged");
    expect(await kindOf(f.storage.stat("/stage/s"))).toBe("not_found");
  });

  it("report any other link failure and keep the staged file", async () => {
    await f.storage.upload("/stage/s", bytes("staged"), { mkdirParents: true });
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
    expect(await kindOf(f.storage.move("/stage/s", "/a.txt", { publish: true }))).toBe("internal");
    expect(await read(f.storage, "/stage/s")).toBe("staged");
  });
});

describe("stat", () => {
  it("reports the inode of a file or folder, as a rename keeps it", async () => {
    await f.storage.upload("/a.txt", bytes("a"));
    await mkdir(join(f.home, "dir"));
    expect((await f.storage.stat("/a.txt")).ino).toBe(
      (await lstat(join(f.home, "a.txt"), { bigint: true })).ino,
    );
    const folder = (await f.storage.stat("/dir")).ino;
    await f.storage.move("/dir", "/moved");
    expect((await f.storage.stat("/moved")).ino).toBe(folder);
  });
});
