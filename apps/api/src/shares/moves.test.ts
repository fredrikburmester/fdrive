import { createMemoryShareRepo, type ShareInsertInput } from "@fdrive/db";
import { describe, expect, it } from "vitest";
import { createMetadataService } from "../metadata/service.ts";
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

function harness(ownerPath?: (identityId: string, path: string) => Promise<OwnedPath | null>) {
  const shares = createMemoryShareRepo();
  const moves = createShareMoves({ shares, ...(ownerPath === undefined ? {} : { ownerPath }) });
  const paths = async (id: string) => (await shares.get(id))?.paths;
  return { shares, moves, paths };
}

/** bob sees alice's `/Team` at `/Shared with me/Team`; `Gone`'s owner has no login. */
const shelf = async (identityId: string, path: string): Promise<OwnedPath | null> => {
  const team = "/Shared with me/Team";
  if (identityId === bob && (path === team || path.startsWith(`${team}/`)))
    return { identityId: alice, path: `/Team${path.slice(team.length)}` };
  if (identityId === bob && path.startsWith("/Shared with me/Gone/")) return null;
  return { identityId, path };
};

describe("public links following their item", () => {
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

  it("follows into the Trash and every other place no link reaches, never staying behind", async () => {
    const { shares, moves, paths } = harness();
    const link = await shares.insert(row(alice, ["/Projects"]));
    let at = "/Projects";
    for (const target of [
      "/.trash/.fdrive-move-v1/Projects",
      "/.fdrive-desktop/x/trash/Projects",
      "/Stuff/.fdrive-backups/Projects",
      "/Shared with me/Projects",
      "/Projects",
    ]) {
      await moves.onMoved(alice, at, target, true);
      expect(await paths(link.id)).toEqual([target]);
      at = target;
    }
  });

  it("goes into the Trash at its leaf, and drops the path when no leaf is known", async () => {
    const { shares, moves, paths } = harness();
    const folder = await shares.insert(row(alice, ["/Projects", "/notes.txt"]));
    await moves.onTrashed?.(alice, "/Projects", "/.trash/leaf", true);
    expect(await paths(folder.id)).toEqual(["/.trash/leaf", "/notes.txt"]);
    await moves.onTrashed?.(alice, "/notes.txt", null, false);
    expect(await paths(folder.id)).toEqual(["/.trash/leaf"]);
  });

  it("drops a deleted item's paths, and the link once nothing is left, so nothing new is served", async () => {
    const { shares, moves, paths } = harness();
    const many = await shares.insert(row(alice, ["/a/x.txt", "/ab/y.txt", "/c"]));
    const only = await shares.insert(row(alice, ["/a"]));
    const foreign = await shares.insert(row(bob, ["/a"]));
    await moves.onDeleted(alice, "/a", true);
    expect(await paths(many.id)).toEqual(["/ab/y.txt", "/c"]);
    expect(await shares.get(only.id)).toBeNull();
    expect(await paths(foreign.id)).toEqual(["/a"]);
    // A file's delete takes only that path.
    await moves.onDeleted(alice, "/c", false);
    await moves.onDeleted(alice, "/ab", false);
    expect(await paths(many.id)).toEqual(["/ab/y.txt"]);
  });

  it("counts moves in a folder shared with someone in its owner's files", async () => {
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
    // Taken out of alice's files, it is gone for her links.
    expect(await moves.resolve(bob, "/Shared with me/Team/sub", "/sub")).toEqual({
      identityId: alice,
      from: "/Team/sub",
      to: null,
    });
    await moves.onMoved(bob, "/Shared with me/Team/sub", "/sub", true);
    expect(await paths(aliceLink.id)).toEqual(["/Team/old/brief.txt"]);
    // bob's own file into alice's folder: followed there, under Shared with me.
    await moves.onMoved(bob, "/mine.txt", "/Shared with me/Team/mine.txt", false);
    expect(await paths(bobLink.id)).toEqual(["/Shared with me/Team/mine.txt"]);
    // bob trashing alice's file into his own Trash takes it from her links.
    await moves.onTrashed?.(bob, "/Shared with me/Team/old/brief.txt", "/.trash/leaf", false);
    expect(await shares.get(aliceLink.id)).toBeNull();
    // A folder whose owner has no login here has no links to follow or drop.
    expect(await moves.resolve(bob, "/Shared with me/Gone/a", "/Shared with me/Gone/b")).toBeNull();
    await moves.onDeleted(bob, "/Shared with me/Gone/a", true);
  });

  it("never moves or drops the root of anyone's files", async () => {
    const { shares, moves, paths } = harness(shelf);
    const whole = await shares.insert(row(alice, ["/"]));
    expect(await moves.resolve(alice, "/a", "/a")).toBeNull();
    expect(await moves.resolve(alice, "/", "/x")).toBeNull();
    expect(await moves.resolve(alice, "/x", "/")).toBeNull();
    expect(await moves.resolve(bob, "/Shared with me/Team/x", "/")).toEqual({
      identityId: alice,
      from: "/Team/x",
      to: null,
    });
    await moves.onDeleted(alice, "/", true);
    expect(await paths(whole.id)).toEqual(["/"]);
  });

  it("goes into and out of the Trash with the metadata hooks, which leave tags behind", async () => {
    const { shares, moves, paths } = harness();
    const link = await shares.insert(row(alice, ["/Projects"]));
    const recents: string[] = [];
    const metadata = createMetadataService({
      followers: [moves, { onMoved: async () => {}, onDeleted: async () => {} }],
      recents: { deletePrefix: async (_id: string, path: string) => void recents.push(path) },
    } as unknown as Parameters<typeof createMetadataService>[0]);
    await metadata.onTrashed(alice, "/Projects", true, "/.trash/leaf");
    expect(await paths(link.id)).toEqual(["/.trash/leaf"]);
    expect(recents).toEqual(["/Projects"]);
    await metadata.onRestored(alice, "/.trash/leaf", "/Back", true);
    expect(await paths(link.id)).toEqual(["/Back"]);
    // Purged from the Trash, it is let go like a delete.
    const purged = await shares.insert(row(alice, ["/.trash/other", "/kept"]));
    await metadata.onPurged(alice, "/.trash/other", true);
    expect(await paths(purged.id)).toEqual(["/kept"]);
    // Trashed with no leaf known, the link drops the path rather than wait at it.
    await metadata.onTrashed(alice, "/Back", true);
    expect(await shares.get(link.id)).toBeNull();
  });
});
