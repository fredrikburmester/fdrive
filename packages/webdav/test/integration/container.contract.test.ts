import {
  createRecycleFolderTrash,
  isStorageError,
  type StorageProvider,
  withMoveToTrash,
} from "@fdrive/core";
import { describeStorageProvider, type SeedUser, startSftpgo } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebdavClient } from "../../src/client.js";
import { webdavModule } from "../../src/module.js";
import { probeConnection } from "../../src/probe.js";
import { createWebdavStorageProvider } from "../../src/storage-provider.js";

type Container = Awaited<ReturnType<typeof startSftpgo>>;

function text(body: ReadableStream<Uint8Array>): Promise<string> {
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

function userNamed(container: Container, username: string): SeedUser {
  const user = container.users.find((candidate) => candidate.username === username);
  if (user === undefined) throw new Error(`seed user ${username} missing`);
  return user;
}

function storageFor(container: Container, user: SeedUser): StorageProvider {
  const client = createWebdavClient({ baseUrl: container.webdavUrl });
  return createWebdavStorageProvider({
    client,
    credential: async () => ({ username: user.username, password: user.password }),
  });
}

/**
 * The provider-neutral behavioural contract against a real class 1 server:
 * SFTPGo's own WebDAV binding, with the seeded users. What
 * `describeStorageProvider` proves on the fake must hold here too.
 */
describe("WebDAV provider against SFTPGo's WebDAV binding", () => {
  let container: Container;

  beforeAll(async () => {
    container = await startSftpgo();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 180_000);

  describeStorageProvider(
    "SFTPGo WebDAV container",
    () => ({ storage: storageFor(container, userNamed(container, "alice")) }),
    { overwritesOnMove: true },
  );

  it("probes the endpoint and authenticates through the module", async () => {
    expect(await probeConnection(container.webdavUrl, { fetch: globalThis.fetch })).toEqual({
      ok: true,
      detail: "WebDAV endpoint is reachable and requires a login",
    });
    const alice = userNamed(container, "alice");
    const instance = { id: "sftpgo-dav", baseUrl: container.webdavUrl, config: {} };
    expect(
      await webdavModule.authenticate(
        instance,
        { username: alice.username, password: alice.password },
        { fetch: globalThis.fetch },
      ),
    ).toEqual({ externalUsername: alice.username });
    expect(
      await kindOf(
        webdavModule.authenticate(
          instance,
          { username: alice.username, password: "wrong" },
          { fetch: globalThis.fetch },
        ),
      ),
    ).toBe("unauthorized");
  });

  it("maps a write the server refuses to forbidden", async () => {
    // bob may create inside /inbox but not at his root (see the testkit seed).
    const bob = storageFor(container, userNamed(container, "bob"));
    expect(await kindOf(bob.mkdir("/denied-at-root"))).toBe("forbidden");
    expect(await kindOf(bob.upload("/denied.txt", new TextEncoder().encode("x")))).toBe(
      "forbidden",
    );
    await expect(bob.mkdir(`/inbox/allowed-${Date.now().toString(36)}`)).resolves.toBeUndefined();
  });

  it("keeps two logins on the same path apart", async () => {
    const alice = storageFor(container, userNamed(container, "alice"));
    const carol = storageFor(container, userNamed(container, "carol"));
    const path = `/same-path-${Date.now().toString(36)}`;
    await alice.upload(`${path}/only-alice.txt`, new TextEncoder().encode("alice"), {
      mkdirParents: true,
    });
    expect(await kindOf(carol.stat(`${path}/only-alice.txt`))).toBe("not_found");
    await carol.upload(`${path}/only-carol.txt`, new TextEncoder().encode("carol"), {
      mkdirParents: true,
    });
    expect((await alice.list(path)).map((entry) => entry.name)).toEqual(["only-alice.txt"]);
    expect((await carol.list(path)).map((entry) => entry.name)).toEqual(["only-carol.txt"]);
    await alice.deleteDir(path);
    await carol.deleteDir(path);
  });

  it("serves byte ranges and falls back to the whole body on a stale If-Range", async () => {
    const alice = storageFor(container, userNamed(container, "alice"));
    const path = `/range-${Date.now().toString(36)}.txt`;
    await alice.upload(path, new TextEncoder().encode("0123456789"));
    const range = await alice.download(path, { range: { start: 2, end: 4 } });
    expect(range.status).toBe(206);
    expect(range.contentRange).toBe("bytes 2-4/10");
    expect(await text(range.body)).toBe("234");
    const stale = await alice.download(path, { range: { start: 2, end: 4 }, ifRange: '"nope"' });
    expect(stale.status).toBe(200);
    expect(await text(stale.body)).toBe("0123456789");
    await alice.deleteFile(path);
  });

  it("moves deletes into a recycle folder, restores them and purges them (the API's Trash for WebDAV)", async () => {
    // The module declares `trash: "move"`: the API storage factory wraps the
    // adapter exactly like this, with the recycle-folder view on top.
    const storage = storageFor(container, userNamed(container, "alice"));
    const trashPath = `/.dav-trash-${Date.now().toString(36)}`;
    const wrapped = withMoveToTrash({ storage, trashPath, clock: () => new Date() });
    const trash = createRecycleFolderTrash({ storage: wrapped, trashPath, layout: "move" });
    const original = `/dav-generic/2026/Å %20/${"x".repeat(200)}`;
    await storage.mkdir(original, { parents: true });
    await storage.upload(`${original}/keep.txt`, new TextEncoder().encode("kept"));
    await wrapped.deleteDir(original);
    expect(await kindOf(storage.stat(original))).toBe("not_found");
    const item = (await trash.list()).entries.find((entry) => entry.originalPath === original);
    expect(item).toBeDefined();
    expect(await trash.restore(item?.id ?? "missing")).toMatchObject({
      path: original,
      kind: "dir",
    });
    expect(await text((await storage.download(`${original}/keep.txt`)).body)).toBe("kept");

    await wrapped.deleteFile(`${original}/keep.txt`);
    const file = (await trash.list()).entries.find(
      (entry) => entry.originalPath === `${original}/keep.txt`,
    );
    expect(file).toMatchObject({ name: "keep.txt", size: 4 });
    await trash.purge([file?.id ?? "missing"]);
    expect((await trash.list()).entries).toEqual([]);

    await wrapped.deleteDir(original);
    expect((await trash.list()).entries).toHaveLength(1);
    await trash.empty();
    expect((await trash.list()).entries).toEqual([]);
    expect(await kindOf(storage.stat(original))).toBe("not_found");
    await storage.deleteDir("/dav-generic");
    await storage.deleteDir(trashPath);
  });
});
