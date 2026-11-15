import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContentStamp, StorageError, type StorageProvider } from "@fdrive/core";
import type { IndexedContent } from "@fdrive/db";
import { createLocalStorage } from "@fdrive/local";
import { createMemoryStorage } from "@fdrive/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { testTrashItems } from "../../test/file-operations.js";
import { memoryRepo } from "../../test/helpers/desktop-repo.js";
import type { Principal } from "../auth/principal.js";
import { createDesktopWrites } from "./writes.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const body = (value: string) => new Response(value).body as ReadableStream<Uint8Array>;
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** The row the indexer records after reading the file `stamp` describes. */
const rowFor = (stamp: ContentStamp, sha256: string): IndexedContent => ({
  rootId: 1,
  path: "old.txt",
  size: stamp.size,
  mtimeNs: stamp.mtimeNs,
  sha256,
  inode: BigInt.asIntN(64, stamp.ino),
  ctimeNs: stamp.ctimeNs,
});

/**
 * Mac writes on storage whose calls a test can watch and interrupt. Another
 * writer is the test changing the raw storage underneath the commit.
 */
async function fixture(
  options: {
    storage?: StorageProvider;
    wrap?: (raw: StorageProvider) => Partial<StorageProvider>;
    access?: () => Promise<void>;
    indexed?: (principal: Principal) => Promise<ReadonlyMap<string, IndexedContent>>;
    logger?: { warn(obj: Record<string, unknown>, msg: string): void };
    verifyAuthority?: () => Promise<boolean>;
    /** What deletes staged files; the raw storage unless given. */
    staging?: StorageProvider;
  } = {},
) {
  const memory = memoryRepo();
  const raw = options.storage ?? createMemoryStorage({ "/old.txt": "old" });
  const storage: StorageProvider = { ...raw, ...options.wrap?.(raw) };
  const principal: Principal = {
    accountId: randomUUID(),
    identityId: randomUUID(),
    username: "test",
    isAdmin: false,
    storage,
    tokenAccess: { mode: "full", paths: ["/"] },
    ...(options.verifyAuthority ? { verifyAuthority: options.verifyAuthority } : {}),
  };
  const service = createDesktopWrites({
    repo: memory.repo,
    storageForIdentity: async () => options.staging ?? raw,
    clock: () => new Date(),
    purge: async () => {},
    trash: testTrashItems({ homeOf: async () => raw }).items,
    ...(options.access
      ? {
          access: async () => {
            await options.access?.();
            return null;
          },
        }
      : {}),
    ...(options.indexed ? { indexedContent: options.indexed } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const save = async (bytes: string, path = "/old.txt", base = "old") => {
    const original = await service.stat(principal, path);
    const request = {
      kind: "upload" as const,
      operationId: randomUUID(),
      parentId: "root",
      name: original.name,
      base: { ...original.version, content: sha(base) },
      itemId: original.id,
      size: Buffer.byteLength(bytes),
      sha256: sha(bytes),
    };
    await service.prepare(principal, request);
    await service.upload(principal, request.operationId, body(bytes), new AbortController().signal);
    return request;
  };
  const create = async (as: Principal, name: string, bytes: string) => {
    const request = {
      kind: "upload" as const,
      operationId: randomUUID(),
      parentId: "root",
      name,
      base: null,
      size: Buffer.byteLength(bytes),
      sha256: sha(bytes),
    };
    await service.prepare(as, request);
    await service.upload(as, request.operationId, body(bytes), new AbortController().signal);
    return request;
  };
  const move = async (path: string, name: string, base?: string) => {
    const original = await service.stat(principal, path);
    const request = {
      kind: "move" as const,
      operationId: randomUUID(),
      itemId: original.id,
      parentId: "root",
      name,
      base: base ? { ...original.version, content: base } : original.version,
    };
    await service.prepare(principal, request);
    return request;
  };
  const folder = async (name: string) => {
    const request = { kind: "folder" as const, operationId: randomUUID(), parentId: "root", name };
    await service.prepare(principal, request);
    return request;
  };
  const read = async (path: string) => new Response((await raw.download(path)).body).text();
  const state = async (id: string) => (await service.status(principal, id)).state;
  return { ...memory, raw, principal, service, save, create, move, folder, read, state };
}

it("publishes a save once the file still has the stamp its base was proven against", async () => {
  const f = await fixture();
  const request = await f.save("saved");
  const result = await f.service.commit(f.principal, request.operationId);
  expect(result).toMatchObject({ state: "completed", recoveryId: null });
  expect(await f.read("/old.txt")).toBe("saved");
});

it("refuses a save whose file changed after its base check, leaving the newer file", async () => {
  // While the commit records what it will publish and rechecks its token.
  let fired = false;
  const raw = createMemoryStorage({ "/old.txt": "old" });
  const f = await fixture({
    storage: raw,
    verifyAuthority: async () => {
      if (!fired) {
        fired = true;
        await raw.upload("/old.txt", body("changed by somebody else"), { overwrite: true });
      }
      return true;
    },
  });
  const request = await f.save("saved");
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    kind: "conflict",
    details: { code: "version_conflict" },
  });
  expect(fired).toBe(true);
  expect(await f.read("/old.txt")).toBe("changed by somebody else");
  expect(await f.state(request.operationId)).toBe("conflict");
});

it("refuses a same-length replacement with the same modification time right before the rename", async () => {
  // Size and time alone cannot see it; the inode and change time can.
  let fired = false;
  const raw = createMemoryStorage({ "/old.txt": "old" });
  const f = await fixture({
    storage: raw,
    verifyAuthority: async () => {
      if (!fired) {
        fired = true;
        const before = await raw.stat("/old.txt");
        await raw.upload("/old.txt", body("new"), {
          overwrite: true,
          ...(before.modifiedAt ? { modifiedAt: before.modifiedAt } : {}),
        });
      }
      return true;
    },
  });
  const request = await f.save("saved");
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    details: { code: "version_conflict" },
  });
  expect(await f.read("/old.txt")).toBe("new");
});

it("refuses a save whose file changed while its base was being read", async () => {
  // The read sees the bytes the client based its edit on; the stamp taken
  // before it is what tells the rename that the file moved on.
  let fired = false;
  const f = await fixture({
    wrap: (raw) => ({
      download: async (path, opts) => {
        const result = await raw.download(path, opts);
        if (!fired && path === "/old.txt") {
          fired = true;
          await raw.upload("/old.txt", body("new"), { overwrite: true });
        }
        return result;
      },
    }),
  });
  const request = await f.save("saved");
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    details: { code: "version_conflict" },
  });
  expect(fired).toBe(true);
  expect(await f.read("/old.txt")).toBe("new");
});

it("proves a save from a current index row without reading the file, and reads a stale one once", async () => {
  const raw = createMemoryStorage({ "/old.txt": "old" });
  const download = vi.spyOn(raw, "download");
  let row: IndexedContent | undefined;
  const f = await fixture({
    storage: raw,
    indexed: async () => new Map(row ? [["/old.txt", row]] : []),
  });
  const stamp = async () => (raw.contentStamp as NonNullable<typeof raw.contentStamp>)("/old.txt");
  row = rowFor(await stamp(), sha("old"));
  const fresh = await f.save("indexed");
  download.mockClear();
  expect((await f.service.commit(f.principal, fresh.operationId)).state).toBe("completed");
  expect(download).not.toHaveBeenCalled();
  // The save gave the file a new stamp, so the old row no longer vouches for it.
  const stale = await f.save("hashed", "/old.txt", "indexed");
  download.mockClear();
  expect((await f.service.commit(f.principal, stale.operationId)).state).toBe("completed");
  expect(download.mock.calls.map(([path]) => path)).toEqual(["/old.txt"]);
  expect(await f.read("/old.txt")).toBe("hashed");
});

it("renames a large file without reading any of it", async () => {
  const large = new Uint8Array(8 * 1024 * 1024).fill(7);
  const raw = createMemoryStorage({});
  await raw.upload("/large.bin", large);
  const download = vi.spyOn(raw, "download");
  const f = await fixture({ storage: raw });
  // A base carrying the file's digest still proves nothing a rename needs.
  const request = await f.move("/large.bin", "renamed.bin", sha(large));
  expect((await f.service.commit(f.principal, request.operationId)).item).toMatchObject({
    path: "/renamed.bin",
  });
  expect(download).not.toHaveBeenCalled();
});

it("refuses a move whose source was replaced since its base check", async () => {
  // Same size and modification time, so the metadata version cannot tell; the inode can.
  let armed = false;
  const raw = createMemoryStorage({ "/old.txt": "old" });
  const f = await fixture({
    storage: raw,
    verifyAuthority: async () => {
      if (!armed) return true;
      const before = await raw.stat("/old.txt");
      await raw.upload("/old.txt", body("new"), {
        overwrite: true,
        ...(before.modifiedAt ? { modifiedAt: before.modifiedAt } : {}),
      });
      return true;
    },
  });
  const request = await f.move("/old.txt", "renamed.txt");
  armed = true;
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    details: { code: "version_conflict" },
  });
  expect(await f.read("/old.txt")).toBe("new");
});

it("moves a folder after something inside it changed", async () => {
  const home = await mkdtemp(join(tmpdir(), "stamp-proof-home-"));
  temporary.push(home);
  const storage = createLocalStorage({ home });
  await storage.mkdir("/Folder");
  const f = await fixture({ storage });
  const request = await f.move("/Folder", "Renamed");
  await writeFile(join(home, "Folder", "new.txt"), "new");
  await utimes(join(home, "Folder"), new Date(0), new Date(0));
  expect((await f.service.commit(f.principal, request.operationId)).item).toMatchObject({
    path: "/Renamed",
  });
  expect(await f.read("/Renamed/new.txt")).toBe("new");
});

it("ends two creates of one name from two Macs with one file and one name collision", async () => {
  const home = await mkdtemp(join(tmpdir(), "stamp-proof-home-"));
  temporary.push(home);
  const storage = createLocalStorage({ home });
  // Both commits find the name free before either publishes.
  let arrived = 0;
  let release: () => void = () => undefined;
  const bothListed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    storage,
    wrap: (raw) => ({
      list: async (path) => {
        const entries = await raw.list(path);
        if (path === "/" && arrived < 2) {
          arrived += 1;
          if (arrived === 2) release();
          await bothListed;
        }
        return entries;
      },
    }),
  });
  const second: Principal = { ...f.principal, identityId: randomUUID() };
  const mine = await f.create(f.principal, "report.txt", "mine");
  const theirs = await f.create(second, "report.txt", "theirs");
  const results = await Promise.allSettled([
    f.service.commit(f.principal, mine.operationId),
    f.service.commit(second, theirs.operationId),
  ]);
  const done = results.filter((result) => result.status === "fulfilled");
  const refused = results.filter((result) => result.status === "rejected");
  expect(arrived).toBe(2);
  expect(done).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
    kind: "conflict",
    details: { code: "name_collision" },
  });
  const winner = (done[0] as PromiseFulfilledResult<{ item: { version: { content: string } } }>)
    .value;
  const content = await f.read("/report.txt");
  expect(winner.item.version.content).toBe(sha(content));
  expect(
    (await storage.list("/"))
      .map((entry) => entry.name)
      .filter((name) => name !== ".fdrive-desktop"),
  ).toEqual(["report.txt"]);
});

it("refuses a name taken between resolution and publication as a collision", async () => {
  // The Mac retries `name_collision` under a numbered name; a bare conflict
  // would fork the file instead.
  const taken = new Set<string>();
  const f = await fixture({
    wrap: (raw) => ({
      move: async (path, target, opts) => {
        if (!taken.has(target)) {
          taken.add(target);
          await raw.upload(target, body("theirs"));
        }
        return raw.move(path, target, opts);
      },
    }),
  });
  const requests = [
    await f.create(f.principal, "new.txt", "mine"),
    await f.folder("reports"),
    await f.move("/old.txt", "taken.txt"),
  ];
  for (const request of requests) {
    await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
      kind: "conflict",
      details: { code: "name_collision" },
    });
    expect(await f.state(request.operationId)).toBe("conflict");
  }
  expect(await f.read("/new.txt")).toBe("theirs");
  expect(await f.read("/taken.txt")).toBe("theirs");
  expect(await f.read("/old.txt")).toBe("old");
});

it("reports a failed recheck as retryable, not as a remote change", async () => {
  // A storage failure says nothing about the file, and a 409 would make the
  // Mac fork a conflict copy of a file nobody touched. Only a missing file is
  // a conflict.
  let armed = false;
  const f = await fixture({
    wrap: (raw) => ({
      contentStamp: async (path) => {
        if (armed) throw new StorageError("upstream_unavailable", "stat failed");
        return (raw.contentStamp as NonNullable<typeof raw.contentStamp>)(path);
      },
    }),
    verifyAuthority: async () => {
      armed = true;
      return true;
    },
  });
  const request = await f.move("/old.txt", "renamed.txt");
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  expect(await f.read("/old.txt")).toBe("old");
  expect(await f.state(request.operationId)).toBe("ready");
});

it("refuses a folder move whose folder went away since its base check", async () => {
  let armed = false;
  const raw = createMemoryStorage({ "/folder/child": "child" });
  const f = await fixture({
    storage: raw,
    verifyAuthority: async () => {
      if (armed) await raw.move("/folder", "/elsewhere");
      return true;
    },
  });
  const request = await f.move("/folder", "renamed");
  armed = true;
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    details: { code: "version_conflict" },
  });
  expect(await f.read("/elsewhere/child")).toBe("child");
  // A failed look at the folder is retryable, not a remote change.
  armed = false;
  const failing = await fixture({
    wrap: (inner) => ({
      stat: async (path) => {
        if (armed && path === "/folder") throw new StorageError("upstream_unavailable", "Offline");
        return inner.stat(path);
      },
    }),
    storage: createMemoryStorage({ "/folder/child": "child" }),
    verifyAuthority: async () => {
      armed = true;
      return true;
    },
  });
  const retry = await failing.move("/folder", "renamed");
  await expect(failing.service.commit(failing.principal, retry.operationId)).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  expect(await failing.state(retry.operationId)).toBe("ready");
});

it("publishes a save even when its staging folder cannot be removed", async () => {
  const warn = vi.fn();
  const f = await fixture({
    logger: { warn },
    staging: {
      ...createMemoryStorage({}),
      deleteDir: async () => {
        throw new StorageError("internal", "Disk gone");
      },
    },
  });
  const request = await f.save("saved");
  expect((await f.service.commit(f.principal, request.operationId)).state).toBe("completed");
  expect(await f.read("/old.txt")).toBe("saved");
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: request.operationId }),
    expect.stringContaining("staging stays"),
  );
});

it("publishes nothing once the pairing is revoked while a save hashes its base", async () => {
  // Revoked and downgraded alike: the token no longer grants what it granted.
  let allowed = true;
  let armed = true;
  const verifyAuthority = vi.fn(async () => allowed);
  const f = await fixture({
    verifyAuthority,
    wrap: (raw) => ({
      download: async (path, opts) => {
        if (armed && path === "/old.txt") allowed = armed = false;
        return raw.download(path, opts);
      },
    }),
  });
  const request = await f.save("saved");
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    kind: "unauthorized",
  });
  expect(await f.read("/old.txt")).toBe("old");
  expect(await f.state(request.operationId)).toBe("ready");
  // One recheck per commit, after the base was read.
  expect(verifyAuthority).toHaveBeenCalledTimes(1);
  allowed = true;
  expect((await f.service.commit(f.principal, request.operationId)).state).toBe("completed");
  expect(verifyAuthority).toHaveBeenCalledTimes(2);
});

it("publishes no create, folder or move once the pairing is revoked", async () => {
  let allowed = true;
  const raw = createMemoryStorage({ "/old.txt": "old" });
  const f = await fixture({ storage: raw, verifyAuthority: async () => allowed });
  // A create is checked right before its staged body is linked into place.
  const create = await f.create(f.principal, "new.txt", "mine");
  allowed = false;
  await expect(f.service.commit(f.principal, create.operationId)).rejects.toMatchObject({
    kind: "unauthorized",
  });
  await expect(raw.stat("/new.txt")).rejects.toMatchObject({ kind: "not_found" });
  expect(await f.state(create.operationId)).toBe("ready");
  const folder = await f.folder("reports");
  const move = await f.move("/old.txt", "renamed.txt");
  for (const request of [folder, move]) {
    await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(await f.state(request.operationId)).toBe("ready");
  }
  expect((await raw.list("/")).map((entry) => entry.path).sort()).toEqual([
    "/.fdrive-desktop",
    "/old.txt",
  ]);
  // A failure of the publication itself is still reported as storage's own.
  allowed = true;
  const failing = await fixture({
    verifyAuthority: async () => true,
    wrap: () => ({
      move: async () => {
        throw new StorageError("payload_too_large", "Disk full");
      },
    }),
  });
  const full = await failing.create(failing.principal, "new.txt", "mine");
  await expect(failing.service.commit(failing.principal, full.operationId)).rejects.toMatchObject({
    kind: "payload_too_large",
  });
});
