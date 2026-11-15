import type { Scope } from "@fdrive/core";
import type { Change, ChangeJournal, ChangePage } from "@fdrive/db";
import { createMemoryStorage } from "@fdrive/testkit";
import { describe, expect, it } from "vitest";
import type { Principal } from "../auth/principal.js";
import { changedPaths, createDesktopChanges, type DesktopChangesDeps } from "./changes.js";

const home: Scope = { fsPrefix: "/alice", virtualPrefix: "/" };
const shared: Scope = {
  fsPrefix: "/bob/Photos",
  virtualPrefix: "/Shared with me/Photos",
};
const scopes = [home, shared];
/** What alice's listings show: nothing in Trash or fdrive's desktop folder. */
const visible = (path: string) =>
  !["/.trash", "/.fdrive-desktop"].some(
    (hidden) => path === hidden || path.startsWith(`${hidden}/`),
  );

function row(path: string, targetPath: string | null = null) {
  return { path, targetPath };
}

describe("changedPaths", () => {
  it("names a changed file, its folder and the folder holding that one", () => {
    expect(changedPaths([row("alice/docs/2026/a.txt")], scopes, visible)).toEqual({
      paths: ["/docs/2026/a.txt"],
      folders: ["/docs", "/docs/2026"],
    });
    // A folder is a path too: its own listing and the two above it.
    expect(changedPaths([row("alice/docs")], scopes, visible)).toEqual({
      paths: ["/docs"],
      folders: ["/"],
    });
  });

  it("names both ends of a move", () => {
    expect(
      changedPaths([row("alice/docs/a.txt", "alice/archive/2026/a.txt")], scopes, visible),
    ).toEqual({
      paths: ["/archive/2026/a.txt", "/docs/a.txt"],
      folders: ["/", "/archive", "/archive/2026", "/docs"],
    });
  });

  it("maps a folder shared with the location to where it shows it, and shadows its own", () => {
    expect(changedPaths([row("bob/Photos/2026/cat.jpg")], scopes, visible)).toEqual({
      paths: ["/Shared with me/Photos/2026/cat.jpg"],
      folders: ["/Shared with me/Photos", "/Shared with me/Photos/2026"],
    });
    expect(changedPaths([row("bob/Photos")], scopes, visible)).toEqual({
      paths: ["/Shared with me/Photos"],
      folders: ["/", "/Shared with me"],
    });
    // Alice's own folder under the mount is hidden by it, as in her listings.
    expect(changedPaths([row("alice/Shared with me/Photos/stale.txt")], scopes, visible)).toEqual({
      paths: [],
      folders: [],
    });
  });

  it("drops what the location cannot list: other homes, Trash and fdrive's own folder", () => {
    expect(
      changedPaths(
        [
          row("bob/private.txt"),
          row("bob"),
          row("carol/Photos/x.jpg"),
          row("alice/.trash/.fdrive-move-v1/a.txt"),
          row("alice/.fdrive-desktop/trash/x"),
        ],
        scopes,
        visible,
      ),
    ).toEqual({ paths: [], folders: [] });
    // Moving into Trash changes where it came from; out of Trash, where it went.
    expect(
      changedPaths(
        [
          row("alice/docs/a.txt", "alice/.trash/.fdrive-move-v1/a.txt"),
          row("alice/.trash/.fdrive-move-v1/b.txt", "alice/b.txt"),
          row("bob/elsewhere/c.txt", "bob/Photos/c.txt"),
        ],
        scopes,
        visible,
      ),
    ).toEqual({
      paths: ["/Shared with me/Photos/c.txt", "/b.txt", "/docs/a.txt"],
      folders: ["/", "/Shared with me", "/Shared with me/Photos", "/docs"],
    });
  });

  it("names each path once, inside the outermost changed path", () => {
    expect(
      changedPaths(
        [
          row("alice/docs/a.txt"),
          row("alice/docs/a.txt"),
          row("alice/docs/sub/b.txt"),
          row("alice/docs"),
          row("alice/notes/c.txt"),
          row("alice/notes b/d.txt"),
        ],
        scopes,
        visible,
      ),
    ).toEqual({
      paths: ["/docs", "/notes/c.txt", "/notes b/d.txt"],
      folders: ["/", "/notes", "/notes b"],
    });
    // The home itself covers everything the location has.
    expect(changedPaths([row("alice/docs/a.txt"), row("alice")], scopes, visible)).toEqual({
      paths: ["/"],
      folders: [],
    });
  });

  it("leaves out a path the Mac app could not take", () => {
    expect(changedPaths([row("alice/docs/bad\u0001name")], scopes, visible)).toEqual({
      paths: [],
      folders: ["/", "/docs"],
    });
  });
});

const principal: Principal = {
  accountId: "account",
  identityId: "alice-identity",
  username: "alice",
  storage: createMemoryStorage({}),
  isAdmin: false,
  tokenAccess: { mode: "full", paths: ["/"] },
};

/** An in-memory journal over `rows`, whose oldest rows `prune` drops. */
function journal(rows: Array<Pick<Change, "path" | "targetPath">>) {
  const state = {
    epoch: "11111111-2222-4333-8444-555555555555",
    rows: rows.map((change, index) => ({ ...change, position: index + 1 })),
  };
  const fake: Pick<ChangeJournal, "read" | "end" | "epoch"> = {
    async epoch() {
      return state.epoch;
    },
    async end() {
      return state.rows.at(-1)?.position ?? 0;
    },
    async read(after, limit): Promise<ChangePage> {
      const oldest = state.rows[0]?.position;
      return {
        gap: oldest !== undefined && after < oldest - 1,
        changes: state.rows
          .filter((change) => change.position > after)
          .slice(0, limit)
          .map((change) => ({
            ...change,
            source: "api",
            content: null,
            createdAt: new Date(0),
          })),
      };
    },
  };
  return {
    state,
    fake,
    append(path: string, targetPath: string | null = null) {
      state.rows.push({ path, targetPath, position: (state.rows.at(-1)?.position ?? 0) + 1 });
    },
  };
}

function feed(overrides: Partial<DesktopChangesDeps> = {}) {
  const log = journal([row("alice/old.txt")]);
  let current: readonly Scope[] = scopes;
  const changes = createDesktopChanges({
    journal: log.fake,
    scopes: async () => current,
    trashPathForStorage: () => "/.trash",
    ...overrides,
  });
  return {
    log,
    changes,
    setScopes(next: readonly Scope[]) {
      current = next;
    },
  };
}

async function settled(
  changes: ReturnType<typeof createDesktopChanges>,
  since: string | undefined,
) {
  const answer = await changes.read(principal, since);
  if (answer.status !== "changes") throw new Error(`expected changes, got ${answer.status}`);
  return answer;
}

describe("createDesktopChanges", () => {
  it("starts a client without an anchor at the journal's end, then answers what came after", async () => {
    const { changes, log } = feed();
    const start = await changes.read(principal, undefined);
    expect(start).toEqual({ status: "resync", anchor: expect.stringMatching(/\.1$/) });
    // Nothing since: the same anchor, nothing to look at.
    expect(await changes.read(principal, start.anchor)).toEqual({
      status: "changes",
      paths: [],
      folders: [],
      anchor: start.anchor,
      more: false,
    });
    log.append("alice/docs/a.txt");
    log.append("bob/Photos/cat.jpg");
    log.append("bob/private.txt");
    const next = await settled(changes, start.anchor);
    expect(next).toMatchObject({
      paths: ["/Shared with me/Photos/cat.jpg", "/docs/a.txt"],
      folders: ["/", "/Shared with me", "/Shared with me/Photos", "/docs"],
      more: false,
    });
    expect(next.anchor).toMatch(/\.4$/);
    // Rows the location cannot see still move the anchor to the end, so a
    // quiet location never falls behind what the journal keeps.
    log.append("carol/y");
    expect((await settled(changes, next.anchor)).anchor).toMatch(/\.5$/);
  });

  it("pages through many rows, each answer's anchor where the next one starts", async () => {
    const { changes, log } = feed({ pageSize: 3 });
    const start = (await changes.read(principal, undefined)).anchor;
    for (const name of ["a", "b", "c", "d"]) log.append(`alice/${name}/file.txt`);
    const first = await settled(changes, start);
    expect(first).toMatchObject({
      paths: ["/a/file.txt", "/b/file.txt", "/c/file.txt"],
      more: true,
    });
    expect(first.anchor).toMatch(/\.4$/);
    const second = await settled(changes, first.anchor);
    expect(second).toMatchObject({ paths: ["/d/file.txt"], folders: ["/", "/d"], more: false });
    expect(second.anchor).toMatch(/\.5$/);
  });

  it("answers resync for an anchor it cannot vouch for", async () => {
    const { changes, log, setScopes } = feed();
    const start = (await changes.read(principal, undefined)).anchor;
    const resync = async (since: string | undefined) =>
      expect((await changes.read(principal, since)).status).toBe("resync");
    for (const garbled of [
      "",
      "v1",
      "v2.x.y.1",
      start.replace(/\.1$/, ".x"),
      `${start}0000000000000000`,
    ])
      await resync(garbled);
    // Past the journal's end: positions started again.
    await resync(start.replace(/\.1$/, ".9"));
    // A restore: the journal has a new epoch.
    log.state.epoch = "99999999-2222-4333-8444-555555555555";
    await resync(start);
    const restored = (await changes.read(principal, undefined)).anchor;
    expect((await changes.read(principal, restored)).status).toBe("changes");
    // A folder shared or unshared changes what the location sees.
    setScopes([home]);
    await resync(restored);
    // Rows after the anchor were pruned: a gap.
    const current = (await changes.read(principal, undefined)).anchor;
    log.append("alice/a.txt");
    log.append("alice/b.txt");
    log.state.rows.splice(0, 2);
    expect(await changes.read(principal, current)).toEqual({
      status: "resync",
      anchor: current.replace(/\.1$/, ".3"),
    });
  });
});
