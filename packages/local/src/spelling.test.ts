import type { PathLike } from "node:fs";
import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isStorageError } from "@fdrive/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fixture, fixture } from "../test/helpers.js";
import { createUserStorage } from "./shared.js";

// A disk that ignores how accents are encoded, as macOS's does, on any test
// disk: it finds a name written either way and reports the one it stores.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    realpath: vi.fn(actual.realpath),
    stat: vi.fn(actual.stat),
  };
});

/** "Å" as one character, the way people and models type it. */
const TYPED = "Årsbesked";
/** "A" and a combining ring, the way macOS stores a name. */
const STORED = "Årsbesked";

let f: Fixture;

beforeEach(async () => {
  f = await fixture();
  await f.storage.list("/");
});

afterEach(async () => {
  vi.mocked(lstat).mockReset();
  vi.mocked(realpath).mockReset();
  vi.mocked(stat).mockReset();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(lstat).mockImplementation(actual.lstat);
  vi.mocked(realpath).mockImplementation(actual.realpath);
  vi.mocked(stat).mockImplementation(actual.stat);
  await f.cleanup();
});

/**
 * Lays `TYPED` out on the real disk and makes the disk answer for either
 * spelling while reporting `STORED`, as an accent-insensitive disk does.
 */
async function insensitiveDisk(): Promise<void> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const onDisk = (path: PathLike) => String(path).replaceAll(STORED, TYPED);
  vi.mocked(lstat).mockImplementation(((path: PathLike) => actual.lstat(onDisk(path))) as never);
  vi.mocked(stat).mockImplementation(((path: PathLike) => actual.stat(onDisk(path))) as never);
  vi.mocked(realpath).mockImplementation((async (path: PathLike) =>
    (await actual.realpath(onDisk(path))).replaceAll(TYPED, STORED)) as never);
}

describe("stat on a disk that ignores how accents are encoded", () => {
  beforeEach(async () => {
    await mkdir(join(f.home, TYPED, "Notes"), { recursive: true });
    await writeFile(join(f.home, TYPED, "Notes", "plan.txt"), "plan");
    await insensitiveDisk();
  });

  it("reports the stored spelling of every folder on the way and of the entry", async () => {
    expect(await f.storage.stat(`/${TYPED}/Notes/plan.txt`)).toMatchObject({
      kind: "file",
      size: 4,
      path: `/${STORED}/Notes/plan.txt`,
    });
    expect(await f.storage.stat(`/${TYPED}`)).toMatchObject({ kind: "dir", path: `/${STORED}` });
  });

  it("says nothing more for a path asked by its stored spelling", async () => {
    expect(await f.storage.stat(`/${STORED}/Notes/plan.txt`)).not.toHaveProperty("path");
    expect(await f.storage.stat("/")).not.toHaveProperty("path");
  });

  it("reports a shared folder's spelling under the name the user sees it by", async () => {
    const bob = createUserStorage({
      home: join(f.root, "bob"),
      shared: async () => [{ name: "Alice's", dir: f.home, ownerHome: f.home, writable: false }],
    });
    expect(await bob.stat(`/Shared with me/Alice's/${TYPED}/Notes`)).toMatchObject({
      kind: "dir",
      path: `/Shared with me/Alice's/${STORED}/Notes`,
    });
    expect(await bob.stat("/Shared with me/Alice's")).not.toHaveProperty("path");
  });
});

describe("stat on this machine's own disk", () => {
  it("reports the stored spelling where the disk finds another one", async () => {
    await mkdir(join(f.home, STORED));
    await writeFile(join(f.home, STORED, "a.txt"), "a");
    const found = await f.storage.stat(`/${TYPED}/a.txt`).catch((error: unknown) => error);
    if (isStorageError(found)) {
      // A disk that compares names exactly (Linux) has nothing at the other spelling.
      expect(found.kind).toBe("not_found");
      return;
    }
    expect(found).toMatchObject({ kind: "file", path: `/${STORED}/a.txt` });
  });
});
