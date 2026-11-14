import { createMemoryShareRepo, type ShareInsertInput } from "@fdrive/db";
import { describe, expect, it } from "vitest";
import { createShareMoves, type OwnedPath } from "./moves.ts";

const alice = "00000000-0000-0000-0000-00000000000a";
const bob = "00000000-0000-0000-0000-00000000000b";
const row = (identityId: string, paths: string[]): ShareInsertInput => ({
  identityId,
  name: "Link",
  description: "",
  scope: "read",
  paths,
  expiresAt: null,
  maxDownloads: 0,
  presentation: "auto",
  passwordHash: null,
  at: new Date("2026-11-14T00:00:00Z"),
});

/** bob sees alice's `/Team` at `/Shared with me/Team`; alice's Trash is `/.trash`. */
function harness(ownerPath?: (identityId: string, path: string) => Promise<OwnedPath | null>) {
  const shares = createMemoryShareRepo();
  const moves = createShareMoves({
    shares,
    trashPathFor: async (identityId) => (identityId === alice ? "/.trash" : null),
    ...(ownerPath === undefined ? {} : { ownerPath }),
  });
  const paths = async (id: string) => (await shares.get(id))?.paths;
  return { shares, moves, paths };
}

const shelf = async (identityId: string, path: string): Promise<OwnedPath | null> => {
  if (
    identityId === bob &&
    (path === "/Shared with me/Team" || path.startsWith("/Shared with me/Team/"))
  )
    return { identityId: alice, path: `/Team${path.slice("/Shared with me/Team".length)}` };
  if (identityId === bob && path.startsWith("/Shared with me/Gone/")) return null;
  return { identityId, path };
};

describe("public links following moves", () => {
  it("follows the owner's moves of a shared item and of a folder above one", async () => {
    const { shares, moves, paths } = harness();
    const folder = await shares.insert(row(alice, ["/Projects"]));
    const inside = await shares.insert(row(alice, ["/Projects/a.txt", "/Other/b.txt"]));
    const sibling = await shares.insert(row(alice, ["/Projectsx/c.txt"]));
    await moves.onMoved(alice, "/Projects", "/Work", true);
    expect(await paths(folder.id)).toEqual(["/Work"]);
    expect(await paths(inside.id)).toEqual(["/Work/a.txt", "/Other/b.txt"]);
    expect(await paths(sibling.id)).toEqual(["/Projectsx/c.txt"]);
    await moves.onMoved(alice, "/Work/a.txt", "/a.txt", false);
    expect(await paths(inside.id)).toEqual(["/a.txt", "/Other/b.txt"]);
  });

  it("never follows into the Trash, the Mac's bookkeeping, a backup folder or Shared with me", async () => {
    const { shares, moves, paths } = harness();
    const link = await shares.insert(row(alice, ["/Projects"]));
    for (const target of [
      "/.trash/.fdrive-move-v1/Projects",
      "/.trash",
      "/.fdrive-desktop/x/trash/Projects",
      "/Stuff/.fdrive-backups/Projects",
      "/Shared with me/Projects",
    ]) {
      expect(await moves.resolve(alice, "/Projects", target)).toBeNull();
      await moves.onMoved(alice, "/Projects", target, true);
      expect(await paths(link.id)).toEqual(["/Projects"]);
    }
    // Without Trash on, its folder is an ordinary one.
    const bobs = await shares.insert(row(bob, ["/notes"]));
    await moves.onMoved(bob, "/notes", "/.trash/notes", true);
    expect(await paths(bobs.id)).toEqual(["/.trash/notes"]);
  });

  it("keeps a deleted item's link where it was", async () => {
    const { shares, moves, paths } = harness();
    const link = await shares.insert(row(alice, ["/Projects"]));
    await moves.onDeleted(alice, "/Projects", true);
    expect(await paths(link.id)).toEqual(["/Projects"]);
  });

  it("follows a move inside a folder shared with someone in its owner's files, and no further", async () => {
    const { shares, moves, paths } = harness(shelf);
    const aliceLink = await shares.insert(row(alice, ["/Team/brief.txt", "/Team/sub"]));
    const bobLink = await shares.insert(row(bob, ["/mine.txt"]));

    await moves.onMoved(
      bob,
      "/Shared with me/Team/brief.txt",
      "/Shared with me/Team/old/brief.txt",
      false,
    );
    expect(await paths(aliceLink.id)).toEqual(["/Team/old/brief.txt", "/Team/sub"]);
    // Out of alice's files into bob's, and into alice's from bob's: nothing follows.
    expect(await moves.resolve(bob, "/Shared with me/Team/sub", "/sub")).toBeNull();
    await moves.onMoved(bob, "/Shared with me/Team/sub", "/sub", true);
    await moves.onMoved(bob, "/mine.txt", "/Shared with me/Team/mine.txt", false);
    expect(await paths(aliceLink.id)).toEqual(["/Team/old/brief.txt", "/Team/sub"]);
    expect(await paths(bobLink.id)).toEqual(["/mine.txt"]);
    // A folder whose owner has no login here has no links to follow.
    expect(await moves.resolve(bob, "/Shared with me/Gone/a", "/Shared with me/Gone/b")).toBeNull();
    // Nothing moves onto or off the root of anyone's files.
    expect(await moves.resolve(alice, "/a", "/a")).toBeNull();
    expect(await moves.resolve(alice, "/", "/x")).toBeNull();
    expect(await moves.resolve(alice, "/x", "/")).toBeNull();
  });
});
