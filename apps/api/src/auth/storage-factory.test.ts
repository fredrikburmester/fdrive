import { moveTrashLeafPath, type StorageProvider } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import type { FilesFolder } from "@fdrive/local";
import { createMemoryStorage } from "@fdrive/testkit";
import { expect, it, vi } from "vitest";
import { ApiHttpError } from "../errors.js";
import { filesFolderFixture, seedLocalUsers } from "../local/test-fixtures/index.ts";
import { createIdentityStorageFactory } from "./storage-factory.ts";

/** Alice's login over a files folder whose storage is `storage` for every user. */
async function fixture(storage: StorageProvider = createMemoryStorage()) {
  const repos = createMemoryRepos();
  const [alice] = await seedLocalUsers(repos, [{ username: "alice", password: "pw" }]);
  if (alice === undefined) throw new Error("unseeded");
  const folder: Pick<FilesFolder, "storage" | "admit"> = {
    storage: vi.fn(() => storage as ReturnType<FilesFolder["storage"]>),
    admit: vi.fn(async () => undefined),
  };
  return { repos, alice, folder };
}

it("builds the login's own storage, once per call, for delayed reads and writes", async () => {
  const h = await fixture();
  const factory = createIdentityStorageFactory({
    identities: h.repos.identities,
    folder: h.folder,
    clock: () => new Date(0),
  });
  const storage = await factory(h.alice.id);
  expect(h.folder.admit).toHaveBeenCalledExactlyOnceWith("alice");
  expect(h.folder.storage).toHaveBeenCalledExactlyOnceWith("alice");
  expect(await storage.list("/")).toEqual([]);
  expect(storage.trash).toBeDefined();
});

it("asks a login that is gone to sign in again", async () => {
  const h = await fixture();
  const factory = createIdentityStorageFactory({
    identities: h.repos.identities,
    folder: h.folder,
    clock: () => new Date(0),
  });
  await expect(factory("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
    kind: "unauthorized",
  });
  expect(h.folder.storage).not.toHaveBeenCalled();
});

it("always moves deletes into the Trash at /.trash", async () => {
  const memory = createMemoryStorage({ "/docs/a.txt": "x" });
  const h = await fixture(memory);
  const at = new Date("2026-09-10T12:00:00Z");
  const factory = createIdentityStorageFactory({
    identities: h.repos.identities,
    folder: h.folder,
    clock: () => at,
  });
  const storage = await factory(h.alice.id);
  await storage.deleteFile("/docs/a.txt");
  const leaf = (BigInt(at.getTime()) * BigInt(1_000_000)).toString();
  expect(memory.dump()).toEqual({
    [moveTrashLeafPath("/.trash", "/docs/a.txt", "file", leaf)]: "x",
  });
  expect((await storage.trash?.list())?.entries).toMatchObject([{ originalPath: "/docs/a.txt" }]);
  // Inside the Trash folder a delete is permanent: that is how purge works.
  await storage.deleteFile(moveTrashLeafPath("/.trash", "/docs/a.txt", "file", leaf));
  expect(memory.dump()).toEqual({});
});

it("deletes for good, with no Trash view, when built without Trash", async () => {
  const memory = createMemoryStorage({ "/.fdrive-desktop/staged.txt": "x" });
  const h = await fixture(memory);
  const factory = createIdentityStorageFactory({
    identities: h.repos.identities,
    folder: h.folder,
    clock: () => new Date(0),
    withoutTrash: true,
  });
  const storage = await factory(h.alice.id);
  expect(storage.trash).toBeUndefined();
  await storage.deleteFile("/.fdrive-desktop/staged.txt");
  expect(memory.dump()).toEqual({});
});

it("asks the files folder to admit the login before building any storage", async () => {
  const repos = createMemoryRepos();
  const local = filesFolderFixture(repos);
  const [alice] = await seedLocalUsers(repos, [{ username: "alice", password: "pw" }]);
  if (alice === undefined) throw new Error("unseeded");
  await repos.localUsers.update("alice", { disabled: true });
  const storage = vi.spyOn(local.folder, "storage");
  const factory = createIdentityStorageFactory({
    identities: repos.identities,
    folder: local.folder,
    clock: () => new Date(0),
  });

  // A user an administrator disabled after they signed in stops at once.
  await expect(factory(alice.id)).rejects.toMatchObject({
    kind: "forbidden",
    message: "this user may not sign in",
  });
  // So does one whose user was removed.
  await repos.localUsers.delete("alice");
  await expect(factory(alice.id)).rejects.toBeInstanceOf(ApiHttpError);
  expect(storage).not.toHaveBeenCalled();

  await seedLocalUsers(repos, [{ username: "alice", password: "pw" }]);
  expect(await (await factory(alice.id)).list("/")).toEqual([]);
  expect(storage).toHaveBeenCalledOnce();
});

it("refuses a login whose name cannot be a home folder, and passes other failures on", async () => {
  const repos = createMemoryRepos();
  const local = filesFolderFixture(repos);
  const account = await repos.accounts.create({ displayName: null });
  const row = await repos.providers.ensure({ type: "local", baseUrl: "local" });
  const odd = await repos.identities.create({
    accountId: account.id,
    providerId: row.id,
    externalUsername: "..",
  });
  const admitted: Pick<FilesFolder, "storage" | "admit"> = {
    storage: local.folder.storage,
    admit: async () => undefined,
  };
  await expect(
    createIdentityStorageFactory({
      identities: repos.identities,
      folder: admitted,
      clock: () => new Date(0),
    })(odd.id),
  ).rejects.toMatchObject({ kind: "forbidden" });

  const failure = new Error("users table unreachable");
  const factory = createIdentityStorageFactory({
    identities: repos.identities,
    folder: {
      storage: local.folder.storage,
      admit: async () => {
        throw failure;
      },
    },
    clock: () => new Date(0),
  });
  await expect(factory(odd.id)).rejects.toBe(failure);
});

it("moves, copies, zips and deletes a folder without listing it first", async () => {
  // Backups no longer write into the files folder, so nothing walks a folder's tree for them
  // before an operation; a backup folder an old release left there moves with its parent.
  const memory = createMemoryStorage({
    "/docs/b.txt": "y",
    "/docs/.fdrive-backups/install/a.fdrive.age": "x",
  });
  const zip = vi.fn(async () => new ReadableStream<Uint8Array>());
  const list = vi.spyOn(memory, "list");
  const h = await fixture(Object.assign(memory, { zip }));
  const factory = createIdentityStorageFactory({
    identities: h.repos.identities,
    folder: h.folder,
    clock: () => new Date(0),
  });
  const storage = await factory(h.alice.id);
  await storage.copy("/docs", "/copy");
  await storage.move("/copy", "/moved");
  await storage.zip?.(["/moved"]);
  await storage.deleteDir("/moved");
  expect(zip).toHaveBeenCalledExactlyOnceWith(["/moved"]);
  expect(list).not.toHaveBeenCalled();
  const binned = moveTrashLeafPath("/.trash", "/moved", "dir", "0");
  expect(memory.dump()).toEqual({
    "/docs/b.txt": "y",
    "/docs/.fdrive-backups/install/a.fdrive.age": "x",
    [`${binned}/b.txt`]: "y",
    [`${binned}/.fdrive-backups/install/a.fdrive.age`]: "x",
  });
});
