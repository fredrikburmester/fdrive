import type { FsEntry } from "@fdrive/contracts";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import {
  createMetadataService,
  DEFAULT_RECENTS_LIMIT,
  hasTrackedMetadata,
  RECENTS_KEEP,
} from "./service.js";

function buildService() {
  const repos = createMemoryRepos();
  const service = createMetadataService(repos);
  return { repos, service };
}

function entry(path: string): FsEntry {
  return {
    name: path.split("/").at(-1) ?? path,
    path,
    kind: "file",
    size: 10,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
  };
}

const IDENTITY_ID = "identity-1";

describe("createMetadataService: decorate", () => {
  it("adds empty meta when nothing is tagged or favorited", async () => {
    const { service } = buildService();

    const decorated = await service.decorate(IDENTITY_ID, [entry("/a.txt")]);

    expect(decorated).toEqual([{ ...entry("/a.txt"), meta: { tagIds: [], favorite: false } }]);
  });

  it("adds tag ids and favorite status per path", async () => {
    const { repos, service } = buildService();
    const account = await repos.accounts.create({ displayName: "Alice" });
    const tag = await repos.tags.create(account.id, { name: "Work", color: null });
    await repos.fileTags.setTags(IDENTITY_ID, "/a.txt", [tag.id]);
    await repos.favorites.add(IDENTITY_ID, "/b.txt", "file");

    const decorated = await service.decorate(IDENTITY_ID, [entry("/a.txt"), entry("/b.txt")]);

    expect(decorated[0]?.meta).toEqual({ tagIds: [tag.id], favorite: false });
    expect(decorated[1]?.meta).toEqual({ tagIds: [], favorite: true });
  });

  it("returns an empty array for no entries", async () => {
    const { service } = buildService();
    expect(await service.decorate(IDENTITY_ID, [])).toEqual([]);
  });
});

describe("createMetadataService: tags", () => {
  it("creates, lists, updates, and deletes a tag", async () => {
    const { repos, service } = buildService();
    const account = await repos.accounts.create({ displayName: "Alice" });

    const created = await service.createTag(account.id, { name: "Work", color: "#ff0000" });
    expect(created).toEqual({ id: created.id, name: "Work", color: "#ff0000" });

    expect(await service.listTags(account.id)).toEqual([created]);

    const updated = await service.updateTag(account.id, created.id, { name: "Job" });
    expect(updated).toEqual({ id: created.id, name: "Job", color: "#ff0000" });

    await service.deleteTag(account.id, created.id);
    expect(await service.listTags(account.id)).toEqual([]);
  });

  it("updateTag returns null for an unknown tag", async () => {
    const { repos, service } = buildService();
    const account = await repos.accounts.create({ displayName: "Alice" });

    expect(await service.updateTag(account.id, "no-such-id", { name: "x" })).toBeNull();
  });
});

describe("createMetadataService: file tags", () => {
  it("sets tags on a path and lists files for a tag", async () => {
    const { repos, service } = buildService();
    const account = await repos.accounts.create({ displayName: "Alice" });
    const tag = await service.createTag(account.id, { name: "Work", color: null });

    await service.setFileTags({ accountId: account.id, identityId: IDENTITY_ID }, "/a.txt", [
      tag.id,
    ]);

    expect(await service.filesForTag(IDENTITY_ID, tag.id)).toEqual(["/a.txt"]);
  });
});

describe("createMetadataService: favorites", () => {
  it("adds, lists, and removes a favorite", async () => {
    const { service } = buildService();

    await service.addFavorite(IDENTITY_ID, "/a.txt", "file");
    const listed = await service.listFavorites(IDENTITY_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.path).toBe("/a.txt");
    expect(listed[0]?.kind).toBe("file");
    expect(listed[0]?.addedAt).toBeInstanceOf(Date);

    await service.removeFavorite(IDENTITY_ID, "/a.txt");
    expect(await service.listFavorites(IDENTITY_ID)).toEqual([]);
  });

  it("rejects a tag owned by another account and writes nothing", async () => {
    const { repos, service } = buildService();
    const alice = await repos.accounts.create({ displayName: "Alice" });
    const bob = await repos.accounts.create({ displayName: "Bob" });
    const mine = await service.createTag(alice.id, { name: "Work", color: null });
    const theirs = await service.createTag(bob.id, { name: "Private", color: null });

    await expect(
      service.setFileTags({ accountId: alice.id, identityId: IDENTITY_ID }, "/a.txt", [
        mine.id,
        theirs.id,
      ]),
    ).rejects.toMatchObject({ name: "UnknownTagError", tagIds: [theirs.id] });

    expect(await service.filesForTag(IDENTITY_ID, mine.id)).toEqual([]);
    expect(await service.filesForTag(IDENTITY_ID, theirs.id)).toEqual([]);
  });
});

describe("createMetadataService: folder views", () => {
  it("sets, reads, and removes a view pin", async () => {
    const { service } = buildService();
    await service.setFolderView(IDENTITY_ID, "/photos", { mode: "grid" });
    expect(await service.getFolderView(IDENTITY_ID, "/photos")).toMatchObject({
      path: "/photos",
      mode: "grid",
      sort: null,
    });
    await service.removeFolderView(IDENTITY_ID, "/photos");
    expect(await service.getFolderView(IDENTITY_ID, "/photos")).toBeNull();
  });

  it("pins a sort on its own and removes parts independently", async () => {
    const { service } = buildService();
    const bySize = { key: "size", direction: "desc" } as const;
    await service.setFolderView(IDENTITY_ID, "/photos", { sort: bySize });
    expect(await service.getFolderView(IDENTITY_ID, "/photos")).toEqual({
      path: "/photos",
      mode: null,
      sort: bySize,
    });
    await service.setFolderView(IDENTITY_ID, "/photos", { mode: "grid" });
    await service.removeFolderView(IDENTITY_ID, "/photos", "sort");
    expect(await service.getFolderView(IDENTITY_ID, "/photos")).toEqual({
      path: "/photos",
      mode: "grid",
      sort: null,
    });
    await service.removeFolderView(IDENTITY_ID, "/photos", "mode");
    expect(await service.getFolderView(IDENTITY_ID, "/photos")).toBeNull();
  });

  it("resets views across every linked identity without touching another account", async () => {
    const { repos, service } = buildService();
    const provider = await repos.providers.ensure({ type: "test", baseUrl: "http://test" });
    const account = await repos.accounts.create({ displayName: "Alice" });
    const otherAccount = await repos.accounts.create({ displayName: "Bob" });
    const first = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "alice-1",
    });
    const second = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "alice-2",
    });
    const other = await repos.identities.create({
      accountId: otherAccount.id,
      providerId: provider.id,
      externalUsername: "bob",
    });
    await Promise.all([
      service.setFolderView(first.id, "/one", { mode: "list" }),
      service.setFolderView(second.id, "/two", { mode: "grid" }),
      service.setFolderView(other.id, "/keep", { mode: "tree" }),
    ]);

    await service.resetFolderViews(account.id);

    await expect(service.getFolderView(first.id, "/one")).resolves.toBeNull();
    await expect(service.getFolderView(second.id, "/two")).resolves.toBeNull();
    await expect(service.getFolderView(other.id, "/keep")).resolves.toMatchObject({ mode: "tree" });
  });
});

describe("createMetadataService: recents", () => {
  it("touches a path and lists it back", async () => {
    const { service } = buildService();

    await service.touchRecent(IDENTITY_ID, "/a.txt");

    const listed = await service.listRecents(IDENTITY_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.path).toBe("/a.txt");
  });

  it("uses DEFAULT_RECENTS_LIMIT when no limit is given", async () => {
    const { service } = buildService();
    for (let i = 0; i < DEFAULT_RECENTS_LIMIT + 5; i += 1) {
      await service.touchRecent(IDENTITY_ID, `/file-${i}.txt`);
    }

    const listed = await service.listRecents(IDENTITY_ID);
    expect(listed).toHaveLength(DEFAULT_RECENTS_LIMIT);
  });

  it("respects an explicit limit", async () => {
    const { service } = buildService();
    await service.touchRecent(IDENTITY_ID, "/a.txt");
    await service.touchRecent(IDENTITY_ID, "/b.txt");

    expect(await service.listRecents(IDENTITY_ID, 1)).toHaveLength(1);
  });

  it("prunes beyond RECENTS_KEEP after every touch", async () => {
    const { repos, service } = buildService();
    for (let i = 0; i < RECENTS_KEEP + 3; i += 1) {
      await service.touchRecent(IDENTITY_ID, `/file-${i}.txt`);
    }

    const all = await repos.recents.list(IDENTITY_ID, RECENTS_KEEP + 10);
    expect(all.length).toBeLessThanOrEqual(RECENTS_KEEP);
  });
});

describe("createMetadataService: onMoved", () => {
  it("rewrites tags, favorites, and recents together", async () => {
    const { repos, service } = buildService();
    const account = await repos.accounts.create({ displayName: "Alice" });
    const tag = await service.createTag(account.id, { name: "Work", color: null });
    await service.setFileTags({ accountId: account.id, identityId: IDENTITY_ID }, "/a.txt", [
      tag.id,
    ]);
    await service.addFavorite(IDENTITY_ID, "/a.txt", "file");
    await service.touchRecent(IDENTITY_ID, "/a.txt");

    await service.onMoved(IDENTITY_ID, "/a.txt", "/b.txt", false);

    expect(await service.filesForTag(IDENTITY_ID, tag.id)).toEqual(["/b.txt"]);
    expect((await service.listFavorites(IDENTITY_ID)).map((f) => f.path)).toEqual(["/b.txt"]);
    expect((await service.listRecents(IDENTITY_ID)).map((r) => r.path)).toEqual(["/b.txt"]);
  });

  it("is idempotent: a second call for the same move is harmless", async () => {
    const { repos, service } = buildService();
    const account = await repos.accounts.create({ displayName: "Alice" });
    const tag = await service.createTag(account.id, { name: "Work", color: null });
    await service.setFileTags({ accountId: account.id, identityId: IDENTITY_ID }, "/a.txt", [
      tag.id,
    ]);

    await service.onMoved(IDENTITY_ID, "/a.txt", "/b.txt", false);
    await service.onMoved(IDENTITY_ID, "/a.txt", "/b.txt", false);

    expect(await service.filesForTag(IDENTITY_ID, tag.id)).toEqual(["/b.txt"]);
  });

  it("rewrites nested paths for a directory move", async () => {
    const { service } = buildService();
    await service.addFavorite(IDENTITY_ID, "/dir/a.txt", "file");

    await service.onMoved(IDENTITY_ID, "/dir", "/moved", true);

    expect((await service.listFavorites(IDENTITY_ID)).map((f) => f.path)).toEqual(["/moved/a.txt"]);
  });

  it("rewrites a folder pin and its subtree", async () => {
    const { service } = buildService();
    await service.setFolderView(IDENTITY_ID, "/dir", { mode: "grid" });
    await service.setFolderView(IDENTITY_ID, "/dir/nested", { mode: "tree" });

    await service.onMoved(IDENTITY_ID, "/dir", "/moved", true);

    await expect(service.getFolderView(IDENTITY_ID, "/dir")).resolves.toBeNull();
    await expect(service.getFolderView(IDENTITY_ID, "/moved")).resolves.toMatchObject({
      mode: "grid",
    });
    await expect(service.getFolderView(IDENTITY_ID, "/moved/nested")).resolves.toMatchObject({
      mode: "tree",
    });
  });
});

describe("createMetadataService: onDeleted", () => {
  it("drops tags, favorites, and recents together", async () => {
    const { repos, service } = buildService();
    const account = await repos.accounts.create({ displayName: "Alice" });
    const tag = await service.createTag(account.id, { name: "Work", color: null });
    await service.setFileTags({ accountId: account.id, identityId: IDENTITY_ID }, "/a.txt", [
      tag.id,
    ]);
    await service.addFavorite(IDENTITY_ID, "/a.txt", "file");
    await service.touchRecent(IDENTITY_ID, "/a.txt");

    await service.onDeleted(IDENTITY_ID, "/a.txt", false);

    expect(await service.filesForTag(IDENTITY_ID, tag.id)).toEqual([]);
    expect(await service.listFavorites(IDENTITY_ID)).toEqual([]);
    expect(await service.listRecents(IDENTITY_ID)).toEqual([]);
  });

  it("is idempotent: deleting an already-gone path is harmless", async () => {
    const { service } = buildService();
    await expect(
      service.onDeleted(IDENTITY_ID, "/never-existed.txt", false),
    ).resolves.toBeUndefined();
  });

  it("drops folder pins under a deleted directory", async () => {
    const { service } = buildService();
    await service.setFolderView(IDENTITY_ID, "/dir", { mode: "grid" });
    await service.setFolderView(IDENTITY_ID, "/dir/nested", { mode: "tree" });

    await service.onDeleted(IDENTITY_ID, "/dir", true);

    await expect(service.getFolderView(IDENTITY_ID, "/dir")).resolves.toBeNull();
    await expect(service.getFolderView(IDENTITY_ID, "/dir/nested")).resolves.toBeNull();
  });
});

describe("createMetadataService: onTrashed", () => {
  it("drops only recents, keeping tags and favorites at the original path", async () => {
    const { repos, service } = buildService();
    const account = await repos.accounts.create({ displayName: "Alice" });
    const tag = await service.createTag(account.id, { name: "Work", color: null });
    await service.setFileTags({ accountId: account.id, identityId: IDENTITY_ID }, "/a.txt", [
      tag.id,
    ]);
    await service.addFavorite(IDENTITY_ID, "/a.txt", "file");
    await service.touchRecent(IDENTITY_ID, "/a.txt");

    await service.onTrashed(IDENTITY_ID, "/a.txt", false);

    expect(await service.filesForTag(IDENTITY_ID, tag.id)).toEqual(["/a.txt"]);
    expect((await service.listFavorites(IDENTITY_ID)).map((f) => f.path)).toEqual(["/a.txt"]);
    expect(await service.listRecents(IDENTITY_ID)).toEqual([]);
  });

  it("is idempotent: trashing an already-gone path is harmless", async () => {
    const { service } = buildService();
    await expect(
      service.onTrashed(IDENTITY_ID, "/never-existed.txt", false),
    ).resolves.toBeUndefined();
  });
});

describe("createMetadataService: onCopied", () => {
  it("does not copy tags or favorites onto the target", async () => {
    const { repos, service } = buildService();
    const account = await repos.accounts.create({ displayName: "Alice" });
    const tag = await service.createTag(account.id, { name: "Work", color: null });
    await service.setFileTags({ accountId: account.id, identityId: IDENTITY_ID }, "/a.txt", [
      tag.id,
    ]);
    await service.addFavorite(IDENTITY_ID, "/a.txt", "file");

    service.onCopied(IDENTITY_ID, "/a.txt", "/copy.txt");

    expect(await service.filesForTag(IDENTITY_ID, tag.id)).toEqual(["/a.txt"]);
    expect((await service.listFavorites(IDENTITY_ID)).map((f) => f.path)).toEqual(["/a.txt"]);
  });
});

describe("hasTrackedMetadata", () => {
  it("is false when a path has no tags and is not favorited", async () => {
    const { repos } = buildService();
    expect(await hasTrackedMetadata(repos, IDENTITY_ID, "/a.txt")).toBe(false);
  });

  it("is true when a path has a tag", async () => {
    const { repos, service } = buildService();
    const account = await repos.accounts.create({ displayName: "Alice" });
    const tag = await service.createTag(account.id, { name: "Work", color: null });
    await service.setFileTags({ accountId: account.id, identityId: IDENTITY_ID }, "/a.txt", [
      tag.id,
    ]);

    expect(await hasTrackedMetadata(repos, IDENTITY_ID, "/a.txt")).toBe(true);
  });

  it("is true when a path is favorited", async () => {
    const { repos, service } = buildService();
    await service.addFavorite(IDENTITY_ID, "/a.txt", "file");

    expect(await hasTrackedMetadata(repos, IDENTITY_ID, "/a.txt")).toBe(true);
  });
});
