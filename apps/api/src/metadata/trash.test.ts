import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { createMetadataService, type MetadataService } from "./service.js";
import { followIntoTrash } from "./trash.js";

const ALICE = "identity-alice";
const BOB = "identity-bob";
const LEAF = "/.trash/0d9f8a52-6c1e-4f53-9a7b-2e4c6d8f0a1b/a.txt";

async function setup() {
  const repos = createMemoryRepos();
  const metadata = createMetadataService(repos);
  // What follows, in order, as `onMoved` and `onDeleted` are told.
  const grants = {
    onMoved: vi.spyOn(metadata as MetadataService, "onMoved"),
    onDeleted: vi.spyOn(metadata as MetadataService, "onDeleted"),
  };
  const account = await repos.accounts.create({ displayName: "Alice" });
  const tag = await metadata.createTag(account.id, { name: "Work", color: null });
  const tagged = (identityId: string, path: string) =>
    metadata.setFileTags({ accountId: account.id, identityId }, path, [tag.id]);
  return { metadata, grants, tag, tagged };
}

describe("followIntoTrash", () => {
  it("moves tags, favorites, folder views and recents to the leaf, where no list shows them", async () => {
    const h = await setup();
    await h.tagged(ALICE, "/a.txt");
    await h.metadata.addFavorite(ALICE, "/a.txt", "file");
    await h.metadata.touchRecent(ALICE, "/a.txt");

    await followIntoTrash(h.metadata, undefined, ALICE, "/a.txt", { leaf: LEAF, kind: "file" });

    expect(h.grants.onMoved).toHaveBeenCalledWith(ALICE, "/a.txt", LEAF, false);
    expect(await h.metadata.filesForTag(ALICE, h.tag.id)).toEqual([]);
    expect(await h.metadata.listFavorites(ALICE)).toEqual([]);
    expect(await h.metadata.listRecents(ALICE)).toEqual([]);
  });

  it("leaves nothing for a new file at the trashed item's old path to inherit", async () => {
    const h = await setup();
    await h.tagged(ALICE, "/a.txt");
    await h.metadata.addFavorite(ALICE, "/a.txt", "file");

    await followIntoTrash(h.metadata, undefined, ALICE, "/a.txt", { leaf: LEAF, kind: "file" });

    // A new file is uploaded at /a.txt: it has no tags and is no favorite.
    const [entry] = await h.metadata.decorate(ALICE, [
      {
        name: "a.txt",
        path: "/a.txt",
        kind: "file",
        size: 1,
        modifiedAt: new Date(0).toISOString(),
        ext: ".txt",
        mime: null,
      },
    ]);
    expect(entry?.meta).toEqual({ tagIds: [], favorite: false });
  });

  it("brings tags and favorites back on restore, a move out of Trash", async () => {
    const h = await setup();
    await h.tagged(ALICE, "/a.txt");
    await h.metadata.addFavorite(ALICE, "/a.txt", "file");
    await followIntoTrash(h.metadata, undefined, ALICE, "/a.txt", { leaf: LEAF, kind: "file" });

    await h.metadata.onMoved(ALICE, LEAF, "/restored.txt", false);

    expect(await h.metadata.filesForTag(ALICE, h.tag.id)).toEqual(["/restored.txt"]);
    expect((await h.metadata.listFavorites(ALICE)).map((item) => item.path)).toEqual([
      "/restored.txt",
    ]);
  });

  it("follows an item in a folder shared with the login into its owner's files, and ends the login's own", async () => {
    const h = await setup();
    const shared = "/Shared with me/Team/a.txt";
    await h.tagged(ALICE, "/Team/a.txt");
    await h.tagged(BOB, shared);
    const ownerPath = vi.fn(async () => ({ identityId: ALICE, path: "/Team/a.txt" }));
    const leaf = "/.trash/7a4b2c1d-3e5f-4a6b-8c7d-9e0f1a2b3c4d/a.txt";

    await followIntoTrash(h.metadata, ownerPath, BOB, shared, { leaf, kind: "file" });

    expect(ownerPath).toHaveBeenCalledWith(BOB, shared);
    expect(h.grants.onMoved).toHaveBeenCalledWith(ALICE, "/Team/a.txt", leaf, false);
    expect(h.grants.onDeleted).toHaveBeenCalledWith(BOB, shared, false);
    // The owner's tag went with the item into their Trash; the login's own ended.
    expect(await h.metadata.filesForTag(ALICE, h.tag.id)).toEqual([]);
    expect(await h.metadata.filesForTag(BOB, h.tag.id)).toEqual([]);
    await h.metadata.onMoved(ALICE, leaf, "/Team/a.txt", false);
    expect(await h.metadata.filesForTag(ALICE, h.tag.id)).toEqual(["/Team/a.txt"]);
  });
});
