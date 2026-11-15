import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { createMetadataService, withFollowers } from "./service.js";
import { isMoveIntoTrash, withTrashMoves } from "./trash-moves.js";

const IDENTITY_ID = "identity-1";
const ACCOUNT_ID = "account-1";

describe("isMoveIntoTrash", () => {
  it("is a move into the Trash folder, or onto it, from outside it", () => {
    expect(isMoveIntoTrash("/docs", "/.trash/.fdrive-move-v1/dir/p/docs/v/1")).toBe(true);
    expect(isMoveIntoTrash("/docs", "/.trash")).toBe(true);
    expect(isMoveIntoTrash("/docs", "/.trash/docs")).toBe(true);
    expect(isMoveIntoTrash("/docs", "/Bin/.fdrive-move-v1/dir/p/docs/v/1")).toBe(false);
    expect(isMoveIntoTrash("/docs", "/.trash-old/docs")).toBe(false);
  });

  it("is an ordinary move out of the Trash or within it", () => {
    expect(isMoveIntoTrash("/.trash/.fdrive-move-v1/dir/p/docs/v/1", "/docs")).toBe(false);
    expect(isMoveIntoTrash("/.trash/a", "/.trash/b")).toBe(false);
  });
});

describe("withTrashMoves", () => {
  function build() {
    const repos = createMemoryRepos();
    const grants = {
      onMoved: vi.fn(async () => undefined),
      onDeleted: vi.fn(async () => undefined),
    };
    const metadata = createMetadataService(repos);
    const wrapped = withFollowers(withTrashMoves(metadata), [grants]);
    return { metadata, grants, wrapped };
  }

  it("keeps tags and favorites where a folder was, and moves its shares with it into the Trash", async () => {
    const { metadata, grants, wrapped } = build();
    const tag = await metadata.createTag(ACCOUNT_ID, { name: "Work", color: null });
    await metadata.setFileTags({ accountId: ACCOUNT_ID, identityId: IDENTITY_ID }, "/docs/a.txt", [
      tag.id,
    ]);
    await metadata.addFavorite(IDENTITY_ID, "/docs", "dir");
    await metadata.touchRecent(IDENTITY_ID, "/docs/a.txt");

    await wrapped.onMoved(IDENTITY_ID, "/docs", "/.trash/.fdrive-move-v1/dir/p/docs/v/1", true);

    // As when fdrive moves it to Trash itself, which reports the same leaf.
    expect(grants.onMoved.mock.calls).toEqual([
      [IDENTITY_ID, "/docs", "/.trash/.fdrive-move-v1/dir/p/docs/v/1", true],
    ]);
    expect(grants.onDeleted).not.toHaveBeenCalled();
    expect(await metadata.filesForTag(IDENTITY_ID, tag.id)).toEqual(["/docs/a.txt"]);
    expect((await metadata.listFavorites(IDENTITY_ID)).map((item) => item.path)).toEqual(["/docs"]);
    // As for a trash made through fdrive: recents of what is in the Trash go.
    expect(await metadata.listRecents(IDENTITY_ID)).toEqual([]);
  });

  it("passes every other move on, including a restore out of the Trash", async () => {
    const { grants, wrapped } = build();
    await wrapped.onMoved(IDENTITY_ID, "/docs", "/Work/docs", true);
    await wrapped.onMoved(IDENTITY_ID, "/.trash/.fdrive-move-v1/dir/p/docs/v/1", "/docs", true);
    expect(grants.onMoved.mock.calls).toEqual([
      [IDENTITY_ID, "/docs", "/Work/docs", true],
      [IDENTITY_ID, "/.trash/.fdrive-move-v1/dir/p/docs/v/1", "/docs", true],
    ]);
  });

  it("leaves deletes and trashes as they are", async () => {
    const { grants, wrapped } = build();
    await wrapped.onDeleted(IDENTITY_ID, "/docs", true);
    await wrapped.onTrashed(IDENTITY_ID, "/other", true, "/.trash/other");
    expect(grants.onDeleted).toHaveBeenCalledWith(IDENTITY_ID, "/docs", true);
    expect(grants.onMoved).toHaveBeenCalledWith(IDENTITY_ID, "/other", "/.trash/other", true);
  });
});
