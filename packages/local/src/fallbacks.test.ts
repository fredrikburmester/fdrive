import { link, lstat, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytes, type Fixture, fixture, kindOf, read } from "../test/helpers.js";

// Failures a test disk cannot produce on demand: filesystems without hard
// links, a move across devices, permission errors and a racing deletion.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    lstat: vi.fn(actual.lstat),
    readdir: vi.fn(actual.readdir),
    realpath: vi.fn(actual.realpath),
    rename: vi.fn(actual.rename),
  };
});

function systemError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

let f: Fixture;

beforeEach(async () => {
  f = await fixture();
  // Create and resolve the home first, so each mock meets the call it targets.
  await f.storage.list("/");
});

afterEach(async () => {
  vi.clearAllMocks();
  await f.cleanup();
});

describe("create-if-absent without hard links", () => {
  it("falls back to checking, then renaming", async () => {
    vi.mocked(link).mockRejectedValueOnce(systemError("ENOTSUP"));
    await f.storage.upload("/n.txt", bytes("new"), { overwrite: false });
    expect(await read(f.storage, "/n.txt")).toBe("new");
  });

  it("still refuses a name taken after the first check", async () => {
    vi.mocked(link).mockImplementationOnce(async (_source, target) => {
      await writeFile(target, "other");
      throw systemError("EOPNOTSUPP");
    });
    expect(await kindOf(f.storage.upload("/n.txt", bytes("new"), { overwrite: false }))).toBe(
      "conflict",
    );
    expect(await readFile(join(f.home, "n.txt"), "utf8")).toBe("other");
  });

  it("reports any other link failure and leaves no partial file", async () => {
    vi.mocked(link).mockRejectedValueOnce(systemError("EIO"));
    expect(await kindOf(f.storage.upload("/a.txt", bytes("a"), { overwrite: false }))).toBe(
      "internal",
    );
    vi.mocked(link).mockRejectedValueOnce(new Error("no code"));
    expect(await kindOf(f.storage.upload("/b.txt", bytes("b"), { overwrite: false }))).toBe(
      "internal",
    );
    expect(await readdir(f.home)).toEqual([]);
  });
});

describe("move across filesystems", () => {
  it("copies, then removes the source", async () => {
    await f.storage.upload("/dir/a.txt", bytes("a"), { mkdirParents: true });
    vi.mocked(rename).mockRejectedValueOnce(systemError("EXDEV"));
    await f.storage.move("/dir", "/moved");
    expect(await read(f.storage, "/moved/a.txt")).toBe("a");
    expect(await kindOf(f.storage.stat("/dir"))).toBe("not_found");
  });

  it("reports any other rename failure", async () => {
    await f.storage.upload("/a.txt", bytes("a"));
    vi.mocked(rename).mockRejectedValueOnce(systemError("EIO"));
    expect(await kindOf(f.storage.move("/a.txt", "/b.txt"))).toBe("internal");
    expect(await read(f.storage, "/a.txt")).toBe("a");
  });
});

describe("filesystem errors while resolving", () => {
  it("refuses a parent it may not resolve", async () => {
    vi.mocked(realpath).mockRejectedValueOnce(systemError("EACCES"));
    expect(await kindOf(f.storage.stat("/a/b"))).toBe("forbidden");
  });

  it("refuses an entry it may not inspect", async () => {
    vi.mocked(lstat).mockRejectedValueOnce(systemError("EACCES"));
    expect(await kindOf(f.storage.stat("/a"))).toBe("forbidden");
    vi.mocked(lstat).mockRejectedValueOnce(systemError("EACCES"));
    expect(await kindOf(f.storage.upload("/a", bytes("a")))).toBe("forbidden");
  });

  it("skips an entry deleted between reading the folder and describing it", async () => {
    await f.storage.upload("/kept.txt", bytes("k"));
    vi.mocked(readdir).mockResolvedValueOnce(["ghost", "kept.txt"] as never);
    expect((await f.storage.list("/")).map((entry) => entry.name)).toEqual(["kept.txt"]);
  });
});
