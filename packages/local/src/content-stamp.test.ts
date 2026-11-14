import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentStamp, StorageProvider } from "@fdrive/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture, kindOf } from "../test/helpers.js";
import { createUserStorage, SHARED_WITH_ME, type UserStorage } from "./shared.js";

/** The storage's stamp, which local storage always has. */
function stampOf(storage: StorageProvider, path: string): Promise<ContentStamp> {
  if (storage.contentStamp === undefined) throw new Error("local storage has no stamp");
  return storage.contentStamp(path);
}

async function downloadAndCancel(storage: StorageProvider, path: string): Promise<void> {
  await (await storage.download(path)).body.cancel();
}

const asRoot = process.getuid?.() === 0;

describe("contentStamp on a home folder", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await fixture();
    await f.storage.list("/");
  });

  afterEach(async () => {
    await f.cleanup();
  });

  it("reports the file's size, times and inode as stat does", async () => {
    await writeFile(join(f.home, "a.txt"), "hello");
    const info = await stat(join(f.home, "a.txt"), { bigint: true });
    expect(await stampOf(f.storage, "/a.txt")).toEqual({
      size: 5,
      mtimeNs: info.mtimeNs,
      ino: info.ino,
      ctimeNs: info.ctimeNs,
    });
  });

  it("changes when the bytes change, even with the old modification time put back", async () => {
    const at = join(f.home, "a.txt");
    await writeFile(at, "hello");
    // A whole millisecond, which `utimes` can put back exactly.
    const mtime = new Date("2026-01-02T03:04:05.678Z");
    await utimes(at, mtime, mtime);
    const before = await stampOf(f.storage, "/a.txt");
    // Long enough for the change time to land on a later tick of any filesystem's clock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(at, "jello");
    await utimes(at, mtime, mtime);
    const after = await stampOf(f.storage, "/a.txt");
    expect({ size: after.size, mtimeNs: after.mtimeNs, ino: after.ino }).toEqual({
      size: before.size,
      mtimeNs: before.mtimeNs,
      ino: before.ino,
    });
    expect(after.ctimeNs).toBeGreaterThan(before.ctimeNs);
  });

  it("names another inode when another file takes the name", async () => {
    await writeFile(join(f.home, "a.txt"), "hello");
    const before = await stampOf(f.storage, "/a.txt");
    await writeFile(join(f.home, "b.txt"), "hello");
    await rename(join(f.home, "b.txt"), join(f.home, "a.txt"));
    expect((await stampOf(f.storage, "/a.txt")).ino).not.toBe(before.ino);
  });

  it("fails exactly as download does", async () => {
    await writeFile(join(f.home, "f.txt"), "f");
    await writeFile(join(f.root, "outside.txt"), "outside");
    await mkdir(join(f.home, "dir"));
    await symlink(join(f.root, "outside.txt"), join(f.home, "out.txt"));
    await symlink(join(f.home, "gone.txt"), join(f.home, "dangling.txt"));
    execFileSync("mkfifo", [join(f.home, "pipe")]);
    await writeFile(join(f.home, "locked.txt"), "locked");
    await chmod(join(f.home, "locked.txt"), 0o000);

    const expected: Record<string, string | null> = {
      "/f.txt": null,
      "/nope.txt": "not_found",
      "/dangling.txt": "not_found",
      "/dir": "bad_request",
      "/pipe": "bad_request",
      "/out.txt": "forbidden",
      "/locked.txt": asRoot ? null : "forbidden",
    };
    const stamped: Record<string, string | null> = {};
    const downloaded: Record<string, string | null> = {};
    for (const path of Object.keys(expected)) {
      stamped[path] = await kindOf(stampOf(f.storage, path));
      downloaded[path] = await kindOf(downloadAndCancel(f.storage, path));
    }
    expect(stamped).toEqual(expected);
    expect(downloaded).toEqual(expected);
  });
});

describe("contentStamp on a user's files", () => {
  let root: string;
  let bob: UserStorage;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "fdrive-stamp-")));
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
    await rm(root, { recursive: true, force: true });
  });

  it("stamps the user's own files and the owner's file behind a shared folder", async () => {
    const shared = await stat(join(root, "alice", "Projects", "brief.txt"), { bigint: true });
    expect(await bob.contentStamp(`/${SHARED_WITH_ME}/Projects/brief.txt`)).toMatchObject({
      size: 5,
      ino: shared.ino,
      ctimeNs: shared.ctimeNs,
    });
    const own = await stat(join(root, "bob", "own.txt"), { bigint: true });
    expect((await bob.contentStamp("/own.txt")).ino).toBe(own.ino);
  });

  it("refuses Shared with me, a shared folder, and what is not there, as download does", async () => {
    const expected = {
      [`/${SHARED_WITH_ME}`]: "bad_request",
      [`/${SHARED_WITH_ME}/Projects`]: "bad_request",
      [`/${SHARED_WITH_ME}/Nope/brief.txt`]: "not_found",
      [`/${SHARED_WITH_ME}/Projects/nope.txt`]: "not_found",
    };
    for (const [path, kind] of Object.entries(expected)) {
      expect(await kindOf(bob.contentStamp(path))).toBe(kind);
      expect(await kindOf(downloadAndCancel(bob, path))).toBe(kind);
    }
  });
});
