import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageProvider } from "@fdrive/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fixture, fixture, kindOf } from "../test/helpers.js";
import { createUserStorage, SHARED_WITH_ME, type UserStorage } from "./shared.js";

// Watched so a test can tell whether a probe opened the file it checked:
// a file that is never opened cannot have any of its content read.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

/** The storage's file probe, which local storage always has. */
function probe(storage: StorageProvider, path: string): Promise<void> {
  if (storage.probeFileRead === undefined) throw new Error("local storage has no file probe");
  return storage.probeFileRead(path);
}

/** The read proof the authorizer used before: open a download, cancel the body. */
async function downloadAndCancel(storage: StorageProvider, path: string): Promise<void> {
  await (await storage.download(path)).body.cancel();
}

const asRoot = process.getuid?.() === 0;

describe("probeFileRead on a home folder", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await fixture();
    await f.storage.list("/");
  });

  afterEach(async () => {
    vi.mocked(open).mockClear();
    await f.cleanup();
  });

  it("proves a file readable without opening it", async () => {
    await writeFile(join(f.home, "big.bin"), Buffer.alloc(1024 * 1024, 1));
    vi.mocked(open).mockClear();

    await expect(probe(f.storage, "/big.bin")).resolves.toBeUndefined();
    expect(open).not.toHaveBeenCalled();

    // The download it replaces opens a descriptor on the file every time.
    await downloadAndCancel(f.storage, "/big.bin");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("fails exactly as download does", async () => {
    await writeFile(join(f.home, "f.txt"), "f");
    await writeFile(join(f.root, "outside.txt"), "outside");
    await mkdir(join(f.home, "dir"));
    await symlink(join(f.home, "f.txt"), join(f.home, "link.txt"));
    await symlink(join(f.root, "outside.txt"), join(f.home, "out.txt"));
    await symlink(join(f.home, "gone.txt"), join(f.home, "dangling.txt"));
    execFileSync("mkfifo", [join(f.home, "pipe")]);
    await writeFile(join(f.home, "locked.txt"), "locked");
    await chmod(join(f.home, "locked.txt"), 0o000);

    const expected: Record<string, string | null> = {
      "/f.txt": null,
      "/link.txt": null,
      "/nope.txt": "not_found",
      "/f.txt/x": "not_found",
      "/dangling.txt": "not_found",
      "/dir": "bad_request",
      "/": "bad_request",
      "/pipe": "bad_request",
      "/out.txt": "forbidden",
      // Root reads every file, so only an ordinary user sees the refusal.
      "/locked.txt": asRoot ? null : "forbidden",
    };
    const probed: Record<string, string | null> = {};
    const downloaded: Record<string, string | null> = {};
    for (const path of Object.keys(expected)) {
      probed[path] = await kindOf(probe(f.storage, path));
      downloaded[path] = await kindOf(downloadAndCancel(f.storage, path));
    }
    expect(probed).toEqual(expected);
    expect(downloaded).toEqual(expected);
  });
});

describe("probeFileRead on a user's files", () => {
  let root: string;
  let bob: UserStorage;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "fdrive-probe-")));
    await mkdir(join(root, "alice", "Projects"), { recursive: true });
    await writeFile(join(root, "alice", "Projects", "brief.txt"), "brief");
    await mkdir(join(root, "bob"), { recursive: true });
    await writeFile(join(root, "bob", "own.txt"), "own");
    bob = createUserStorage({
      home: join(root, "bob"),
      shared: async () => [
        {
          name: "Projects",
          dir: join(root, "alice", "Projects"),
          ownerHome: join(root, "alice"),
          writable: false,
        },
      ],
    });
  });

  afterEach(async () => {
    vi.mocked(open).mockClear();
    await rm(root, { recursive: true, force: true });
  });

  it("proves the user's own files and shared files without opening them", async () => {
    vi.mocked(open).mockClear();
    await expect(bob.probeFileRead("/own.txt")).resolves.toBeUndefined();
    await expect(bob.probeFileRead(`/${SHARED_WITH_ME}/Projects/brief.txt`)).resolves.toBe(
      undefined,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses Shared with me, a shared folder, and what is not there, as download does", async () => {
    const expected = {
      [`/${SHARED_WITH_ME}`]: "bad_request",
      [`/${SHARED_WITH_ME}/Projects`]: "bad_request",
      [`/${SHARED_WITH_ME}/Nope/brief.txt`]: "not_found",
      [`/${SHARED_WITH_ME}/Projects/nope.txt`]: "not_found",
    };
    for (const [path, kind] of Object.entries(expected)) {
      expect(await kindOf(bob.probeFileRead(path))).toBe(kind);
      expect(await kindOf(downloadAndCancel(bob, path))).toBe(kind);
    }
  });
});
