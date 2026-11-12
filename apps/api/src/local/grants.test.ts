import { randomUUID } from "node:crypto";
import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { createIdentityStorageFactory } from "../auth/storage-factory.js";
import { createTokenSource } from "../auth/token-source.js";
import {
  memoryProviderService,
  seedLocalProvider,
  seedWebdavProvider,
} from "../providers/test-fixtures/index.ts";
import { createLocalGrantService, type LocalGrantServiceDeps } from "./grants.js";
import { localModuleFixture, seedLocalUsers, writeHomeFiles } from "./test-fixtures/index.ts";

/**
 * Alice, Bob and Carol on the local folder (Dave disabled), Alice also on
 * WebDAV, with folders in Alice's and Carol's homes and Trash at `/.trash`.
 */
async function fixture(options: Partial<LocalGrantServiceDeps> = {}) {
  const repos = createMemoryRepos();
  const local = localModuleFixture(repos);
  await seedLocalUsers(repos, [
    { username: "alice", password: "alice-pass" },
    { username: "bob", password: "bob-pass" },
    { username: "carol", password: "carol-pass" },
    { username: "dave", password: "dave-pass", disabled: true },
  ]);
  writeHomeFiles(local.root, "alice", {
    "/Projects/plan.txt": "plan",
    "/Photos/2026/beach.jpg": "jpg",
    "/notes.txt": "notes",
    "/.trash/old/file.txt": "old",
  });
  writeHomeFiles(local.root, "carol", { "/Projects/carol.txt": "carol" });
  const row = await seedLocalProvider(repos);
  const dav = await seedWebdavProvider(repos, "http://dav.test");
  const providers = memoryProviderService(repos, { modules: { local: local.module } });
  const master = Buffer.alloc(32, 41);
  const tokenSource = createTokenSource({
    repos,
    providers,
    master,
    clock: () => new Date(),
    fetch,
  });
  const storageFor = createIdentityStorageFactory({
    providers,
    tokenSource,
    fetch,
    clock: () => new Date(),
  });
  async function login(providerId: string, username: string) {
    const account = await repos.accounts.create({ displayName: username });
    return repos.identities.create({
      accountId: account.id,
      providerId,
      externalUsername: username,
    });
  }
  const alice = await login(row.id, "alice");
  const bob = await login(row.id, "bob");
  const carol = await login(row.id, "carol");
  const aliceOnDav = await login(dav.id, "alice");
  const service = createLocalGrantService({
    repos,
    providerId: async () => row.id,
    storageFor,
    trashPathFor: async () => "/.trash",
    ...options,
  });
  return { repos, local, row, alice, bob, carol, aliceOnDav, service, storageFor };
}

describe("createLocalGrantService: sharing a folder", () => {
  it("shares a folder, which the other user finds under Shared with me", async () => {
    const h = await fixture();
    const grant = await h.service.create(h.alice.id, {
      path: "/Projects/",
      username: "BOB",
      access: "write",
    });
    expect(grant).toEqual({
      id: expect.any(String),
      path: "/Projects",
      username: "bob",
      access: "write",
      createdAt: expect.any(String),
    });
    expect(await h.service.list(h.alice.id)).toEqual({
      available: true,
      owned: [grant],
      received: [],
    });
    expect(await h.service.list(h.bob.id)).toEqual({
      available: true,
      owned: [],
      received: [
        {
          id: grant.id,
          owner: "alice",
          name: "Projects",
          path: "/Shared with me/Projects",
          access: "write",
          createdAt: grant.createdAt,
        },
      ],
    });
    // Bob's own storage reaches it, confined to that folder.
    const bobs = await h.storageFor(h.bob.id);
    expect((await bobs.list("/Shared with me/Projects")).map((entry) => entry.name)).toEqual([
      "plan.txt",
    ]);
  });

  it("names two shared folders of the same name by their owners", async () => {
    const h = await fixture();
    await h.service.create(h.alice.id, { path: "/Projects", username: "bob", access: "read" });
    await h.service.create(h.carol.id, { path: "/Projects", username: "bob", access: "read" });
    expect((await h.service.list(h.bob.id)).received.map((grant) => grant.name)).toEqual([
      "Projects (alice)",
      "Projects (carol)",
    ]);
    expect(await h.service.received(h.bob)).toEqual([
      { name: "Projects (alice)", owner: "alice", path: "/Projects", writable: false },
      { name: "Projects (carol)", owner: "carol", path: "/Projects", writable: false },
    ]);
  });

  it.each([
    ["all of your files", "/", "bad_request", "share a folder, not all of your files"],
    [
      "a folder shared with you",
      "/Shared with me/Projects",
      "bad_request",
      "a folder shared with you cannot be shared on",
    ],
    ["Trash", "/.trash", "bad_request", "Trash cannot be shared"],
    ["a folder in Trash", "/.trash/old", "bad_request", "Trash cannot be shared"],
    ["a file", "/notes.txt", "bad_request", "only folders can be shared"],
    ["a folder that does not exist", "/Missing", "not_found", "folder not found"],
  ])("refuses to share %s", async (_name, path, kind, message) => {
    const h = await fixture();
    await expect(
      h.service.create(h.alice.id, { path, username: "bob", access: "read" }),
    ).rejects.toMatchObject({ kind, message });
    expect(await h.repos.localGrants.listOwned("alice")).toEqual([]);
  });

  it("refuses a missing person, and sharing with yourself", async () => {
    const h = await fixture();
    const share = (username: string) =>
      h.service.create(h.alice.id, { path: "/Projects", username, access: "read" });
    await expect(share("zoe")).rejects.toMatchObject({
      kind: "not_found",
      message: "no such user",
    });
    await expect(share("Alice")).rejects.toMatchObject({
      kind: "bad_request",
      message: "you already have this folder",
    });
  });

  it("shares nothing while Trash is the whole of the user's files", async () => {
    const h = await fixture({ trashPathFor: async () => "/" });
    await expect(
      h.service.create(h.alice.id, { path: "/Projects", username: "bob", access: "read" }),
    ).rejects.toMatchObject({ kind: "bad_request", message: "Trash cannot be shared" });
  });

  it("shares a folder named like Trash while Trash is off", async () => {
    const h = await fixture({ trashPathFor: async () => null });
    expect(
      await h.service.create(h.alice.id, { path: "/.trash", username: "bob", access: "read" }),
    ).toMatchObject({ path: "/.trash" });
    // A deployment that gives the service no Trash at all.
    const plain = await fixture();
    const noTrash = createLocalGrantService({
      repos: plain.repos,
      providerId: async () => plain.row.id,
      storageFor: plain.storageFor,
    });
    expect(
      await noTrash.create(plain.alice.id, {
        path: "/.trash",
        username: "bob",
        access: "read",
      }),
    ).toMatchObject({ path: "/.trash" });
  });

  it("passes a storage failure other than a missing folder through", async () => {
    const forbidden = new StorageError("forbidden", "no access");
    const h = await fixture({
      storageFor: async () =>
        ({
          stat: async () => {
            throw forbidden;
          },
        }) as unknown as StorageProvider,
    });
    await expect(
      h.service.create(h.alice.id, { path: "/Projects", username: "bob", access: "read" }),
    ).rejects.toBe(forbidden);
  });
});

describe("createLocalGrantService: changing and ending shares", () => {
  it("lets the owner change the access, and nobody else", async () => {
    const h = await fixture();
    const grant = await h.service.create(h.alice.id, {
      path: "/Projects",
      username: "bob",
      access: "read",
    });
    expect(await h.service.update(h.alice.id, grant.id, { access: "write" })).toMatchObject({
      id: grant.id,
      access: "write",
    });
    for (const [identityId, id] of [
      [h.bob.id, grant.id],
      [h.alice.id, randomUUID()],
    ] as const) {
      await expect(h.service.update(identityId, id, { access: "read" })).rejects.toMatchObject({
        kind: "not_found",
      });
    }
    expect((await h.repos.localGrants.get(grant.id))?.access).toBe("write");
  });

  it("lets the owner stop sharing and the other person leave, and nobody else", async () => {
    const h = await fixture();
    const share = () =>
      h.service.create(h.alice.id, { path: "/Projects", username: "bob", access: "read" });
    const first = await share();
    await expect(h.service.remove(h.carol.id, first.id)).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(h.service.remove(h.alice.id, randomUUID())).rejects.toMatchObject({
      kind: "not_found",
    });
    await h.service.remove(h.bob.id, first.id);
    expect(await h.repos.localGrants.get(first.id)).toBeNull();
    const second = await share();
    await h.service.remove(h.alice.id, second.id);
    expect(await h.repos.localGrants.get(second.id)).toBeNull();
  });

  it("follows the owner's folder moves and ends with its deletion, ignoring files", async () => {
    const h = await fixture();
    await h.service.create(h.alice.id, { path: "/Photos/2026", username: "bob", access: "read" });
    await h.service.onMoved(h.alice.id, "/Photos", "/Pictures", false);
    expect((await h.repos.localGrants.listOwned("alice"))[0]?.path).toBe("/Photos/2026");
    await h.service.onMoved(h.alice.id, "/Photos", "/Pictures", true);
    expect((await h.repos.localGrants.listOwned("alice"))[0]?.path).toBe("/Pictures/2026");
    await h.service.onDeleted(h.alice.id, "/Pictures", false);
    expect(await h.repos.localGrants.listOwned("alice")).toHaveLength(1);
    await h.service.onDeleted(h.alice.id, "/Pictures", true);
    expect(await h.repos.localGrants.listOwned("alice")).toEqual([]);
  });

  it("ignores moves and deletes on other storage, whose paths are not the folder's", async () => {
    const h = await fixture();
    await h.service.create(h.alice.id, { path: "/Projects", username: "bob", access: "read" });
    await h.service.onMoved(h.aliceOnDav.id, "/Projects", "/Elsewhere", true);
    await h.service.onDeleted(h.aliceOnDav.id, "/Projects", true);
    expect((await h.repos.localGrants.listOwned("alice"))[0]?.path).toBe("/Projects");
  });
});

describe("createLocalGrantService: who can share", () => {
  it("offers the other active users to share with", async () => {
    const h = await fixture();
    expect(await h.service.people(h.alice.id)).toEqual({ usernames: ["bob", "carol"] });
  });

  it("is unavailable to a login on other storage, which never sees local shares", async () => {
    const h = await fixture();
    await h.service.create(h.alice.id, { path: "/Projects", username: "bob", access: "read" });
    expect(await h.service.list(h.aliceOnDav.id)).toEqual({
      available: false,
      owned: [],
      received: [],
    });
    expect(await h.service.received(h.aliceOnDav)).toEqual([]);
    const refused = { kind: "unsupported", details: { capability: "grants" } };
    await expect(h.service.people(h.aliceOnDav.id)).rejects.toMatchObject(refused);
    await expect(
      h.service.create(h.aliceOnDav.id, { path: "/Projects", username: "bob", access: "read" }),
    ).rejects.toMatchObject(refused);
    await expect(h.service.people(randomUUID())).rejects.toMatchObject(refused);
  });

  it("is unavailable to everyone on a deployment without a local folder", async () => {
    const h = await fixture({ providerId: async () => null });
    expect((await h.service.list(h.alice.id)).available).toBe(false);
    expect(await h.service.received(h.bob)).toEqual([]);
    const moved = vi.spyOn(h.repos.localGrants, "movePrefix");
    await h.service.onMoved(h.alice.id, "/a", "/b", true);
    expect(moved).not.toHaveBeenCalled();
  });
});
