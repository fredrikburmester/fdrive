import { randomUUID } from "node:crypto";
import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { createIdentityStorageFactory } from "../auth/storage-factory.js";
import { createLocalGrantService, type LocalGrantServiceDeps } from "./grants.js";
import {
  filesFolderFixture,
  seedLocalUsers,
  seedStorageRow,
  writeHomeFiles,
} from "./test-fixtures/index.ts";

/**
 * Alice, Bob and Carol (Dave disabled), with folders in Alice's and Carol's
 * homes and Trash at `/.trash`.
 */
async function fixture(options: Partial<LocalGrantServiceDeps> = {}) {
  const repos = createMemoryRepos();
  const local = filesFolderFixture(repos);
  const [alice, bob, carol] = await seedLocalUsers(repos, [
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
  const row = await seedStorageRow(repos);
  const storageFor = createIdentityStorageFactory({
    identities: repos.identities,
    folder: local.folder,
    clock: () => new Date(),
  });
  if (alice === undefined || bob === undefined || carol === undefined) throw new Error("unseeded");
  const service = createLocalGrantService({
    repos,
    storageId: row.id,
    storageFor,
    trashPathFor: async () => "/.trash",
    ...options,
  });
  return { repos, local, row, alice, bob, carol, service, storageFor };
}

const RESERVED = "fdrive's own folders, like Trash, cannot be shared";

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
      owned: [grant],
      received: [],
    });
    expect(await h.service.list(h.bob.id)).toEqual({
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
    expect(await h.service.received("bob")).toEqual([
      { name: "Projects (alice)", owner: "alice", path: "/Projects", writable: false },
      { name: "Projects (carol)", owner: "carol", path: "/Projects", writable: false },
    ]);
  });

  it("tells which paths are inside a folder shared to view only", async () => {
    const h = await fixture();
    await h.service.create(h.alice.id, { path: "/Projects", username: "bob", access: "read" });
    await h.service.create(h.carol.id, { path: "/Projects", username: "bob", access: "write" });
    expect(await h.service.isReadOnly(h.bob, "/Shared with me/Projects (alice)/a.docx")).toBe(true);
    expect(await h.service.isReadOnly(h.bob, "/Shared with me/Projects (alice)")).toBe(true);
    expect(await h.service.isReadOnly(h.bob, "/Shared with me/Projects (carol)/a.docx")).toBe(
      false,
    );
    expect(await h.service.isReadOnly(h.bob, "/Shared with me/Projects (alice)x/a.docx")).toBe(
      false,
    );
    expect(await h.service.isReadOnly(h.bob, "/Projects/a.docx")).toBe(false);
  });

  it.each([
    ["all of your files", "/", "bad_request", "share a folder, not all of your files"],
    [
      "a folder shared with you",
      "/Shared with me/Projects",
      "bad_request",
      "a folder shared with you cannot be shared on",
    ],
    ["Trash", "/.trash", "bad_request", RESERVED],
    ["a folder in Trash", "/.trash/old", "bad_request", RESERVED],
    ["the Mac app's folder", "/.fdrive-desktop/staging", "bad_request", RESERVED],
    ["fdrive's Trash layout", "/old/.fdrive-move-v1/dir", "bad_request", RESERVED],
    ["a backup folder", "/nas/.fdrive-backups", "bad_request", RESERVED],
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

  it("shares a folder named like Trash while Trash is off", async () => {
    const h = await fixture({ trashPathFor: async () => null });
    expect(
      await h.service.create(h.alice.id, { path: "/.trash", username: "bob", access: "read" }),
    ).toMatchObject({ path: "/.trash" });
    // A deployment that gives the service no Trash at all.
    const plain = await fixture();
    const noTrash = createLocalGrantService({
      repos: plain.repos,
      storageId: plain.row.id,
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

  it("places a path in a folder shared with a user in its owner's files", async () => {
    const h = await fixture();
    await h.service.create(h.alice.id, { path: "/Projects", username: "bob", access: "write" });
    await h.service.create(h.carol.id, { path: "/Projects", username: "bob", access: "read" });
    expect(await h.service.ownerPath(h.bob.id, "/Shared with me/Projects (alice)/a/b.txt")).toEqual(
      {
        identityId: h.alice.id,
        path: "/Projects/a/b.txt",
      },
    );
    expect(await h.service.ownerPath(h.bob.id, "/Shared with me/Projects (carol)")).toEqual({
      identityId: h.carol.id,
      path: "/Projects",
    });
    // Anything else is the user's own: their files, the shelf itself, a name nobody shares.
    for (const path of ["/notes.txt", "/Shared with me", "/Shared with me/Other/x"])
      expect(await h.service.ownerPath(h.bob.id, path)).toEqual({ identityId: h.bob.id, path });
    // A login that is gone keeps the path it asked about.
    const gone = randomUUID();
    expect(await h.service.ownerPath(gone, "/Shared with me/Projects/x")).toEqual({
      identityId: gone,
      path: "/Shared with me/Projects/x",
    });
  });

  it("finds an owner's path back in each login's files", async () => {
    const h = await fixture();
    await h.service.create(h.alice.id, { path: "/Projects", username: "bob", access: "write" });
    await h.service.create(h.alice.id, { path: "/Photos", username: "bob", access: "read" });
    await h.service.create(h.alice.id, { path: "/Photos/2026", username: "bob", access: "write" });
    await h.service.create(h.carol.id, { path: "/Projects", username: "bob", access: "read" });
    const alices = (path: string) => ({ identityId: h.alice.id, path });
    expect(await h.service.pathFor(h.alice.id, alices("/Projects/plan.txt"))).toBe(
      "/Projects/plan.txt",
    );
    expect(await h.service.pathFor(h.bob.id, alices("/Projects/a/b.txt"))).toBe(
      "/Shared with me/Projects (alice)/a/b.txt",
    );
    expect(
      await h.service.pathFor(h.bob.id, { identityId: h.carol.id, path: "/Projects/c.txt" }),
    ).toBe("/Shared with me/Projects (carol)/c.txt");
    // The most specific of two folders shared one inside the other.
    expect(await h.service.pathFor(h.bob.id, alices("/Photos/2026/beach.jpg"))).toBe(
      "/Shared with me/2026/beach.jpg",
    );
    // Not shared with the login, or a login that is gone: unreachable.
    expect(await h.service.pathFor(h.bob.id, alices("/notes.txt"))).toBeNull();
    expect(await h.service.pathFor(h.carol.id, alices("/Projects/plan.txt"))).toBeNull();
    expect(await h.service.pathFor(randomUUID(), alices("/Projects/plan.txt"))).toBeNull();
    expect(await h.service.pathFor(h.bob.id, { identityId: randomUUID(), path: "/x" })).toBeNull();
    // Bob's own folder named like a folder shared with him is hidden behind it.
    const bobs = (path: string) => ({ identityId: h.bob.id, path });
    expect(await h.service.pathFor(h.bob.id, bobs("/Shared with me/2026/own.txt"))).toBeNull();
    expect(await h.service.pathFor(h.bob.id, bobs("/Shared with me/Other/own.txt"))).toBe(
      "/Shared with me/Other/own.txt",
    );
    // Every path found round-trips through `ownerPath`.
    const shared = "/Shared with me/Projects (alice)/a/b.txt";
    expect(await h.service.ownerPath(h.bob.id, shared)).toEqual(alices("/Projects/a/b.txt"));
  });

  it("keeps a share that followed its folder into Trash from the person it is shared with", async () => {
    const closedFolders = vi.fn(async (): Promise<readonly string[]> => ["/.trash"]);
    const h = await fixture({ closedFolders });
    await h.service.create(h.alice.id, { path: "/Photos/2026", username: "bob", access: "read" });
    await h.service.create(h.alice.id, { path: "/Projects", username: "bob", access: "write" });
    await h.service.create(h.carol.id, { path: "/Projects", username: "bob", access: "read" });
    const leaf = "/.trash/.fdrive-move-v1/dir/p/Projects/v/1";
    writeHomeFiles(h.local.root, "alice", { [`${leaf}/plan.txt`]: "plan" });
    await h.service.onMoved(h.alice.id, "/Projects", leaf, true);
    await h.service.onMoved(h.alice.id, "/Photos/2026", "/.trash/loose", true);

    expect(await h.service.received("bob")).toEqual([
      { name: "Projects", owner: "carol", path: "/Projects", writable: false },
    ]);
    expect(closedFolders).toHaveBeenCalled();
    expect((await h.service.list(h.bob.id)).received.map((grant) => grant.name)).toEqual([
      "Projects",
    ]);
    expect(await h.service.isReadOnly(h.bob, "/Shared with me/1/plan.txt")).toBe(false);
    // Bob's storage agrees: the leaf in fdrive's Trash layout is refused there too.
    const bobs = await h.storageFor(h.bob.id);
    expect((await bobs.list("/Shared with me")).map((entry) => entry.name)).not.toContain("1");

    // Trash turned off: what is still in fdrive's Trash layout stays closed; the rest opens.
    closedFolders.mockResolvedValue([]);
    expect((await h.service.received("bob")).map((folder) => folder.name)).toEqual([
      "loose",
      "Projects",
    ]);
  });

  it("ignores moves and deletes of a login that is gone", async () => {
    const h = await fixture();
    await h.service.create(h.alice.id, { path: "/Projects", username: "bob", access: "read" });
    await h.service.onMoved(randomUUID(), "/Projects", "/Elsewhere", true);
    await h.service.onDeleted(randomUUID(), "/Projects", true);
    expect((await h.repos.localGrants.listOwned("alice"))[0]?.path).toBe("/Projects");
  });
});

describe("createLocalGrantService: who can share", () => {
  it("offers the other active users to share with", async () => {
    const h = await fixture();
    expect(await h.service.people(h.alice.id)).toEqual({ usernames: ["bob", "carol"] });
  });

  it("asks a login that is gone to sign in again", async () => {
    const h = await fixture();
    const refused = { kind: "unauthorized" };
    await expect(h.service.list(randomUUID())).rejects.toMatchObject(refused);
    await expect(h.service.people(randomUUID())).rejects.toMatchObject(refused);
    await expect(
      h.service.create(randomUUID(), { path: "/Projects", username: "bob", access: "read" }),
    ).rejects.toMatchObject(refused);
  });
});
