import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageSession } from "@fdrive/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytes, kindOf, streamOf } from "../test/helpers.js";
import { type DiskChange, type IndexChange, notify, relativeTo, underRoot } from "./changes.js";
import { createIndexListener, createLocalModule, type LocalUsers } from "./module.js";
import { createUserStorage, SHARED_WITH_ME } from "./shared.js";
import { createLocalStorage, published } from "./storage-provider.js";

let root: string;
let changes: DiskChange[];
const listen = (change: DiskChange) => {
  changes.push(change);
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "fdrive-changes-")));
  changes = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("notify", () => {
  it("does nothing without a listener and never passes on a listener's error", () => {
    expect(() => notify(undefined, { kind: "changed", path: "/x" })).not.toThrow();
    const throwing = vi.fn(() => {
      throw new Error("listener broke");
    });
    expect(() => notify(throwing, { kind: "changed", path: "/x" })).not.toThrow();
    expect(throwing).toHaveBeenCalledOnce();
  });
});

describe("relativeTo and underRoot", () => {
  it("names paths below the root with / and no leading slash, and nothing else", () => {
    expect(relativeTo("/data", "/data/alice/a b/c.txt")).toBe("alice/a b/c.txt");
    expect(relativeTo("/data", "/data")).toBeNull();
    expect(relativeTo("/data", "/elsewhere/x")).toBeNull();
    expect(relativeTo("/data", "/database/x")).toBeNull();
    expect(relativeTo("/data/alice", "/data")).toBeNull();
    expect(relativeTo("/data", "/data/..x/y")).toBe("..x/y");
  });

  it("keeps an upload's content and turns a half-outside move into a change", () => {
    const content = { sha256: "a".repeat(64), size: 3, mtimeNs: 5n, ino: 7n, ctimeNs: 8n };
    expect(underRoot("/data", { kind: "changed", path: "/data/a/x", content })).toEqual({
      kind: "changed",
      path: "a/x",
      content,
    });
    expect(underRoot("/data", { kind: "changed", path: "/data/a/x" })).toEqual({
      kind: "changed",
      path: "a/x",
    });
    expect(underRoot("/data", { kind: "changed", path: "/tmp/x" })).toBeNull();
    expect(underRoot("/data", { kind: "moved", path: "/data/a/x", target: "/data/a/y" })).toEqual({
      kind: "moved",
      path: "a/x",
      target: "a/y",
    });
    expect(underRoot("/data", { kind: "moved", path: "/data/a/x", target: "/tmp/y" })).toEqual({
      kind: "changed",
      path: "a/x",
    });
    expect(underRoot("/data", { kind: "moved", path: "/tmp/x", target: "/data/a/y" })).toEqual({
      kind: "changed",
      path: "a/y",
    });
    expect(underRoot("/data", { kind: "moved", path: "/tmp/x", target: "/tmp/y" })).toBeNull();
  });
});

describe("local storage changes", () => {
  const home = () => join(root, "alice");
  const storage = () => createLocalStorage({ home: home(), onChange: listen });

  it("reports an upload with the digest, size and time of the bytes it published", async () => {
    const files = storage();
    const modifiedAt = new Date("2024-02-03T04:05:06.789Z");
    await files.upload("/a.txt", streamOf(["hello ", "world"]), { modifiedAt });
    await files.upload("/b.txt", bytes("bytes"), { overwrite: false });
    const [a, b] = await Promise.all([
      stat(join(home(), "a.txt"), { bigint: true }),
      stat(join(home(), "b.txt"), { bigint: true }),
    ]);
    // `utimes` takes float seconds, so the stored time is only near the `Date`:
    // the change must carry what the disk holds, not what was asked for.
    expect(a.mtimeNs / 1_000_000n).toBe(BigInt(modifiedAt.getTime()));
    expect(changes).toEqual([
      {
        kind: "changed",
        path: join(home(), "a.txt"),
        content: {
          sha256: sha256("hello world"),
          size: 11,
          mtimeNs: a.mtimeNs,
          ino: a.ino,
          ctimeNs: a.ctimeNs,
        },
      },
      {
        kind: "changed",
        path: join(home(), "b.txt"),
        content: {
          sha256: sha256("bytes"),
          size: 5,
          mtimeNs: b.mtimeNs,
          ino: b.ino,
          ctimeNs: b.ctimeNs,
        },
      },
    ]);
  });

  it("ties an upload's digest to the inode it published, or to nothing", async () => {
    const at = join(root, "x.txt");
    await writeFile(at, "x");
    const info = await stat(at, { bigint: true });
    const written = { sha256: sha256("x"), size: 1, mtimeNs: info.mtimeNs, ino: info.ino };
    expect(await published(at, written)).toEqual({
      content: { ...written, ctimeNs: info.ctimeNs },
    });
    // Another writer's file at the name, or none at all: no digest to trust.
    expect(await published(at, { ...written, ino: info.ino + 1n })).toEqual({});
    expect(await published(join(root, "missing.txt"), written)).toEqual({});
  });

  it("reports an overwrite with the new bytes", async () => {
    const files = storage();
    await files.upload("/a.txt", bytes("old"));
    await files.upload("/a.txt", streamOf(["new!"]), {
      overwrite: true,
      contentLength: 4,
      signal: new AbortController().signal,
    });
    expect(await readFile(join(home(), "a.txt"), "utf8")).toBe("new!");
    expect(changes.at(-1)).toMatchObject({
      kind: "changed",
      path: join(home(), "a.txt"),
      content: { sha256: sha256("new!"), size: 4 },
    });
  });

  it("reports nothing for an upload that did not publish", async () => {
    const files = storage();
    expect(await kindOf(files.upload("/a.txt", streamOf(["x"], new Error("cut off"))))).not.toBe(
      null,
    );
    const controller = new AbortController();
    controller.abort();
    expect(
      await kindOf(files.upload("/b.txt", streamOf(["x"]), { signal: controller.signal })),
    ).not.toBe(null);
    expect(await kindOf(files.upload("/c.txt", bytes("short"), { contentLength: 9 }))).toBe(
      "bad_request",
    );
    await files.upload("/d.txt", bytes("d"));
    changes = [];
    expect(await kindOf(files.upload("/d.txt", bytes("again"), { overwrite: false }))).toBe(
      "conflict",
    );
    expect(changes).toEqual([]);
  });

  it("still finishes an operation whose listener throws", async () => {
    const files = createLocalStorage({
      home: home(),
      onChange: () => {
        throw new Error("listener broke");
      },
    });
    await files.upload("/a.txt", bytes("a"));
    await files.move("/a.txt", "/b.txt");
    expect(await readFile(join(home(), "b.txt"), "utf8")).toBe("a");
  });

  it("uploads without a listener as before", async () => {
    const files = createLocalStorage({ home: home() });
    await files.upload("/a.txt", streamOf(["a", "b"]));
    expect(await readFile(join(home(), "a.txt"), "utf8")).toBe("ab");
  });

  it("reports moves, copies, deletes, new times and new folders", async () => {
    const files = storage();
    await files.mkdir("/dir");
    await files.upload("/dir/a.txt", bytes("a"));
    changes = [];
    await files.move("/dir/a.txt", "/dir/b.txt");
    await files.copy("/dir", "/copy");
    await files.copy("/dir/b.txt", "/c.txt");
    await files.setModifiedAt?.("/c.txt", new Date("2020-01-01T00:00:00Z"));
    await files.deleteFile("/c.txt");
    await files.deleteDir("/copy");
    await files.deleteDir("/");
    await files.mkdir("/again");
    expect(changes).toEqual([
      { kind: "moved", path: join(home(), "dir", "a.txt"), target: join(home(), "dir", "b.txt") },
      { kind: "changed", path: join(home(), "copy") },
      { kind: "changed", path: join(home(), "c.txt") },
      { kind: "changed", path: join(home(), "c.txt") },
      { kind: "changed", path: join(home(), "c.txt") },
      { kind: "changed", path: join(home(), "copy") },
      { kind: "changed", path: home() },
      { kind: "changed", path: join(home(), "again") },
    ]);
  });

  it("reports the first folder a mkdir with parents made, and nothing when all existed", async () => {
    const files = storage();
    await files.mkdir("/x");
    changes = [];
    await files.mkdir("/x/y/z", { parents: true });
    await files.mkdir("/x/y", { parents: true });
    await expect(files.mkdir("/x")).rejects.toThrow();
    expect(changes).toEqual([{ kind: "changed", path: join(home(), "x", "y") }]);
  });

  it("reports the file a link leads to when its time changes", async () => {
    const files = storage();
    await files.upload("/real.txt", bytes("r"));
    await symlink(join(home(), "real.txt"), join(home(), "link.txt"));
    changes = [];
    await files.setModifiedAt?.("/link.txt", new Date("2020-01-01T00:00:00Z"));
    expect(changes).toEqual([{ kind: "changed", path: join(home(), "real.txt") }]);
  });

  it("reports nothing for an operation that failed", async () => {
    const files = storage();
    expect(await kindOf(files.move("/missing", "/x"))).toBe("not_found");
    expect(await kindOf(files.copy("/missing", "/x"))).toBe("not_found");
    expect(await kindOf(files.deleteFile("/missing"))).toBe("not_found");
    expect(changes).toEqual([]);
  });
});

describe("user storage changes", () => {
  const alice = (...parts: string[]) => join(root, "alice", ...parts);
  const bob = (...parts: string[]) => join(root, "bob", ...parts);

  beforeEach(async () => {
    await mkdir(alice("Projects"), { recursive: true });
    await writeFile(alice("Projects", "brief.txt"), "brief");
    await mkdir(bob(), { recursive: true });
    await writeFile(bob("own.txt"), "own");
  });

  function bobsFiles() {
    return createUserStorage({
      home: bob(),
      shared: async () => [
        { name: "Projects", dir: alice("Projects"), ownerHome: alice(), writable: true },
      ],
      onChange: listen,
    });
  }

  it("reports changes in a shared folder by where they are on disk", async () => {
    const files = bobsFiles();
    await files.upload(`/${SHARED_WITH_ME}/Projects/new.txt`, bytes("n"));
    await files.move(`/${SHARED_WITH_ME}/Projects/new.txt`, `/${SHARED_WITH_ME}/Projects/n.txt`);
    expect(changes).toEqual([
      {
        kind: "changed",
        path: alice("Projects", "new.txt"),
        content: expect.objectContaining({ sha256: sha256("n"), size: 1 }),
      },
      { kind: "moved", path: alice("Projects", "new.txt"), target: alice("Projects", "n.txt") },
    ]);
  });

  it("reports a move or copy between the user's files and a shared folder", async () => {
    const files = bobsFiles();
    await files.move("/own.txt", `/${SHARED_WITH_ME}/Projects/own.txt`);
    await files.copy(`/${SHARED_WITH_ME}/Projects/brief.txt`, "/brief.txt");
    expect(changes).toEqual([
      { kind: "moved", path: bob("own.txt"), target: alice("Projects", "own.txt") },
      { kind: "changed", path: bob("brief.txt") },
    ]);
  });
});

describe("local module index changes", () => {
  const instance = { id: "p1", baseUrl: "http://local.invalid", config: {} };
  const ctx = { fetch: globalThis.fetch };
  const users: LocalUsers = {
    verify: async (username) => ({ result: "ok", username }),
    status: async () => "active",
    shared: async () => [],
  };
  const session = (externalUsername: string): StorageSession => ({
    externalUsername,
  });

  it("reports changes under the index root by the indexer's paths, in order", async () => {
    // The root as configured may be a link to the real folder; storage reports real paths.
    const link = join(await realpath(await mkdtemp(join(tmpdir(), "fdrive-link-"))), "root");
    await symlink(root, link);
    const heard: [string, IndexChange][] = [];
    const module = createLocalModule({
      root: link,
      users,
      indexRoot: "files",
      onIndexChange: (name, change) => heard.push([name, change]),
    });
    const files = module.createStorage(instance, session("alice"), ctx);
    await files.upload("/docs/a.txt", bytes("a"), { mkdirParents: true });
    await files.move("/docs/a.txt", "/docs/b.txt");
    await files.deleteFile("/docs/b.txt");
    await vi.waitFor(() => expect(heard).toHaveLength(3));
    expect(heard).toEqual([
      [
        "files",
        {
          kind: "changed",
          path: "alice/docs/a.txt",
          content: expect.objectContaining({ sha256: sha256("a") }),
        },
      ],
      ["files", { kind: "moved", path: "alice/docs/a.txt", target: "alice/docs/b.txt" }],
      ["files", { kind: "changed", path: "alice/docs/b.txt" }],
    ]);
    await rm(join(link, ".."), { recursive: true, force: true });
  });

  it("reports nothing without an index root, and survives a root it cannot resolve", async () => {
    const hear = vi.fn(() => {
      throw new Error("never reached");
    });
    const unindexed = createLocalModule({ root, users, indexRoot: null, onIndexChange: hear });
    await unindexed.createStorage(instance, session("alice"), ctx).upload("/a.txt", bytes("a"));
    const quiet = createLocalModule({ root, users, indexRoot: "files" });
    await quiet.createStorage(instance, session("alice"), ctx).upload("/b.txt", bytes("b"));

    const throwing = createLocalModule({ root, users, indexRoot: "files", onIndexChange: hear });
    await throwing.createStorage(instance, session("alice"), ctx).upload("/c.txt", bytes("c"));
    await vi.waitFor(() => expect(hear).toHaveBeenCalledOnce());
  });

  it("tries the root again after it could not be resolved, keeping order", async () => {
    const resolve = vi
      .fn<(path: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("not mounted"))
      .mockResolvedValue("/data");
    const heard: IndexChange[] = [];
    const listener = createIndexListener(
      "/data",
      "files",
      (_root, change) => {
        heard.push(change);
      },
      resolve,
    );
    listener({ kind: "changed", path: "/data/a/lost.txt" });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    await Promise.resolve();
    listener({ kind: "changed", path: "/data/a/one.txt" });
    listener({ kind: "moved", path: "/data/a/one.txt", target: "/elsewhere/one.txt" });
    listener({ kind: "changed", path: "/elsewhere/two.txt" });
    await vi.waitFor(() => expect(heard).toHaveLength(2));
    expect(heard).toEqual([
      { kind: "changed", path: "a/one.txt" },
      { kind: "changed", path: "a/one.txt" },
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
