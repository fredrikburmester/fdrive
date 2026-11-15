import { createMemoryShareRepo, type ShareInsertInput } from "@fdrive/db";
import { describe, expect, it } from "vitest";
import { memoryAccessRepo, testAccessFollowers } from "../../test/file-operations.js";

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";

/** Bob finds alice's `/Team` at `/Shared with me/Team`; every other path is the login's own. */
const ownerPath = async (identityId: string, path: string) =>
  identityId === BOB &&
  (path === "/Shared with me/Team" || path.startsWith("/Shared with me/Team/"))
    ? { identityId: ALICE, path: path.replace("/Shared with me/Team", "/Team") }
    : { identityId, path };

const usernameOf = async (identityId: string) =>
  identityId === ALICE ? "alice" : identityId === BOB ? "bob" : null;

function harness() {
  const repo = memoryAccessRepo();
  return { repo, access: testAccessFollowers(repo, { ownerPath, usernameOf }) };
}

describe("what grants access follows a move in its owner's files", () => {
  it("moves links, shares with people and Office files together for the owner", async () => {
    const { repo, access } = harness();
    await access.moved(ALICE, "/Projects", "/Work", true);
    expect(repo.changes).toEqual([
      {
        directory: true,
        shares: { identityId: ALICE, from: "/Projects", to: "/Work" },
        grants: { owner: "alice", from: "/Projects", to: "/Work" },
        office: {
          from: { identityId: ALICE, path: "/Projects" },
          to: { identityId: ALICE, path: "/Work" },
        },
      },
    ]);
  });

  it("follows a move by someone a folder is shared with in the owner's files, folders shared with people too", async () => {
    const { repo, access } = harness();
    await access.moved(BOB, "/Shared with me/Team/sub", "/Shared with me/Team/renamed", true);
    expect(repo.changes[0]).toMatchObject({
      shares: { identityId: ALICE, from: "/Team/sub", to: "/Team/renamed" },
      grants: { owner: "alice", from: "/Team/sub", to: "/Team/renamed" },
    });
  });

  it("ends the owner's links and shares with people once someone takes the item out of their files", async () => {
    const { repo, access } = harness();
    await access.moved(BOB, "/Shared with me/Team/sub", "/sub", true);
    expect(repo.changes[0]).toMatchObject({
      shares: { identityId: ALICE, from: "/Team/sub", to: null },
      grants: { owner: "alice", from: "/Team/sub", to: null },
      // The document goes along into bob's files.
      office: {
        from: { identityId: ALICE, path: "/Team/sub" },
        to: { identityId: BOB, path: "/sub" },
      },
    });
  });

  it("shares only folders with people, and keeps nothing for a login that is gone", async () => {
    const { repo, access } = harness();
    await access.moved(ALICE, "/a.txt", "/b.txt", false);
    await access.moved("00000000-0000-4000-8000-0000000000ff", "/x", "/y", true);
    expect(repo.changes.map((change) => change.grants)).toEqual([null, null]);
  });

  it("never moves an owner's root, and does nothing for a move onto itself", async () => {
    const { repo, access } = harness();
    await access.moved(ALICE, "/a", "/a", true);
    await access.moved(ALICE, "/", "/x", true);
    expect(repo.changes).toEqual([]);
  });

  it("ends everything at a path that is gone, never an owner's root", async () => {
    const { repo, access } = harness();
    await access.removed(BOB, "/Shared with me/Team/old", true);
    await access.removed(ALICE, "/", true);
    await access.removed(ALICE, "/notes.txt", false);
    expect(repo.changes).toEqual([
      {
        directory: true,
        shares: { identityId: ALICE, from: "/Team/old", to: null },
        grants: { owner: "alice", from: "/Team/old", to: null },
        office: { from: { identityId: ALICE, path: "/Team/old" }, to: null },
      },
      {
        directory: false,
        shares: { identityId: ALICE, from: "/notes.txt", to: null },
        grants: null,
        office: { from: { identityId: ALICE, path: "/notes.txt" }, to: null },
      },
    ]);
  });

  it("applies what it planned to the stores", async () => {
    const shares = createMemoryShareRepo();
    const access = testAccessFollowers(memoryAccessRepo({ shares }), { ownerPath, usernameOf });
    const link = await shares.insert(row(["/Team/brief.txt"]));
    await access.moved(BOB, "/Shared with me/Team/brief.txt", "/Shared with me/Team/v2.txt", false);
    expect((await shares.get(link.id))?.paths).toEqual(["/Team/v2.txt"]);
    await access.removed(ALICE, "/Team/v2.txt", false);
    expect(await shares.get(link.id)).toBeNull();
  });
});

describe("the paths a file operation holds", () => {
  it("holds a vacated path alone and every folder above a touched path, in their owners' files", async () => {
    const { repo, access } = harness();
    const result = await access.run(
      BOB,
      { vacates: ["/Shared with me/Team/sub"], creates: ["/mine/new"] },
      async (follow) => {
        await follow.moved(BOB, "/Shared with me/Team/sub", "/mine/new", true);
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(repo.locks).toEqual([
      [
        { identityId: ALICE, path: "/Team/sub", exclusive: true },
        { identityId: ALICE, path: "/Team", exclusive: false },
        { identityId: ALICE, path: "/", exclusive: false },
        { identityId: BOB, path: "/mine/new", exclusive: false },
        { identityId: BOB, path: "/mine", exclusive: false },
        { identityId: BOB, path: "/", exclusive: false },
      ],
    ]);
    expect(repo.changes).toHaveLength(1);
  });

  it("keeps nothing it was handed when the operation fails", async () => {
    const { repo, access } = harness();
    await expect(
      access.run(ALICE, { vacates: ["/a"] }, async (follow) => {
        await follow.moved(ALICE, "/a", "/b", true);
        throw new Error("storage refused");
      }),
    ).rejects.toThrow("storage refused");
    expect(repo.changes).toEqual([]);
  });

  it("follows a change made outside fdrive holding nothing", async () => {
    const { repo, access } = harness();
    await access.moved(ALICE, "/a", "/b", true);
    await access.removed(ALICE, "/b", true);
    expect(repo.locks).toEqual([[], []]);
  });
});

function row(paths: string[]): ShareInsertInput {
  return {
    identityId: ALICE,
    name: "Link",
    description: "",
    scope: "read",
    paths,
    expiresAt: null,
    maxDownloads: 0,
    presentation: "auto",
    passwordHash: null,
    at: new Date("2026-11-15T00:00:00Z"),
  };
}
