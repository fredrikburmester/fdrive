import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageProvider } from "@fdrive/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytes, kindOf, read, streamOf, zipEntries } from "../test/helpers.js";
import {
  closedToShares,
  createUserStorage,
  SHARED_WITH_ME,
  type SharedFolder,
  sharedFolderNames,
} from "./shared.js";

let root: string;
let bob: StorageProvider;
let shared: ReturnType<typeof vi.fn<() => Promise<readonly SharedFolder[]>>>;

const alice = (...parts: string[]) => join(root, "alice", ...parts);

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "fdrive-shared-")));
  await mkdir(alice("Projects", "plans"), { recursive: true });
  await writeFile(alice("Projects", "brief.txt"), "brief");
  await mkdir(alice("Photos"), { recursive: true });
  await writeFile(alice("Photos", "cat.jpg"), "cat");
  await writeFile(alice("secret.txt"), "secret");
  await mkdir(join(root, "bob"), { recursive: true });
  await writeFile(join(root, "bob", "own.txt"), "own");
  shared = vi.fn(async () => [
    {
      name: "Projects",
      dir: alice("Projects"),
      owner: "alice",
      ownerHome: alice(),
      writable: true,
    },
    { name: "Photos", dir: alice("Photos"), owner: "alice", ownerHome: alice(), writable: false },
  ]);
  bob = createUserStorage({ home: join(root, "bob"), shared });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const names = async (path: string) => (await bob.list(path)).map((entry) => entry.name).sort();

describe("sharedFolderNames", () => {
  it("uses the folder's name, then the owner, then a number to keep names apart", () => {
    expect(
      sharedFolderNames([
        { owner: "alice", path: "/Projects", writable: true },
        { owner: "carol", path: "/Work/Projects", writable: false },
        { owner: "carol", path: "/Old/Projects", writable: false },
        { owner: "dave", path: "/Photos", writable: false },
        { owner: "erin", path: "/", writable: false },
      ]),
    ).toEqual(["Projects (alice)", "Projects (carol)", "Projects (carol, 2)", "Photos", "erin"]);
  });
});

describe("closedToShares", () => {
  it("closes fdrive's own folders and Trash's old layout wherever it is", () => {
    expect(closedToShares("/.trash")).toBe(true);
    expect(closedToShares("/.trash/Old")).toBe(true);
    expect(closedToShares("/.trash/.fdrive-move-v1/dir/p/Old/v/1")).toBe(true);
    expect(closedToShares("/.fdrive-desktop/id/trash/Old")).toBe(true);
    // A Trash an earlier version kept elsewhere: what is still in it stays closed.
    expect(closedToShares("/Bin/.fdrive-move-v1/dir/p/Old/v/1")).toBe(true);
    expect(closedToShares("/.trashy/Old")).toBe(false);
    expect(closedToShares("/Projects")).toBe(false);
  });
});

describe("createUserStorage", () => {
  it("lists Shared with me beside the user's own files and asks for shares once", async () => {
    expect(await names("/")).toEqual([SHARED_WITH_ME, "own.txt"]);
    expect(await names(`/${SHARED_WITH_ME}`)).toEqual(["Photos", "Projects"]);
    expect(await bob.stat(`/${SHARED_WITH_ME}`)).toMatchObject({ kind: "dir" });
    expect(shared).toHaveBeenCalledTimes(1);
  });

  it("reserves the name whether or not anything is shared, leaving a real folder on disk", async () => {
    await mkdir(join(root, "bob", SHARED_WITH_ME));
    await writeFile(join(root, "bob", SHARED_WITH_ME, "mine.txt"), "mine");
    expect((await bob.list("/")).filter((entry) => entry.name === SHARED_WITH_ME)).toHaveLength(1);
    expect(await names(`/${SHARED_WITH_ME}`)).toEqual(["Photos", "Projects"]);
    const alone = createUserStorage({ home: join(root, "bob"), shared: async () => [] });
    expect((await alone.list("/")).map((entry) => entry.name)).toEqual(["own.txt"]);
    expect(await alone.list(`/${SHARED_WITH_ME}`)).toEqual([]);
    expect(await kindOf(alone.download(`/${SHARED_WITH_ME}/mine.txt`))).toBe("not_found");
    for (const change of [
      alone.upload(`/${SHARED_WITH_ME}/new.txt`, bytes("x")),
      alone.mkdir(`/${SHARED_WITH_ME}`),
      alone.move("/own.txt", `/${SHARED_WITH_ME}`),
      alone.copy("/own.txt", `/${SHARED_WITH_ME}`),
      alone.deleteDir(`/${SHARED_WITH_ME}`),
    ]) {
      expect(await kindOf(change)).toBe("forbidden");
    }
    await expect(alone.mkdir(`/${SHARED_WITH_ME}`)).rejects.toThrow(/is reserved/);
    // Untouched on disk.
    expect(await readFile(join(root, "bob", SHARED_WITH_ME, "mine.txt"), "utf8")).toBe("mine");
  });

  it("leaves out a shared folder its owner removed or that is not a folder", async () => {
    const odd = createUserStorage({
      home: join(root, "bob"),
      shared: async () => [
        { name: "Gone", dir: alice("Gone"), owner: "alice", ownerHome: alice(), writable: true },
        {
          name: "File",
          dir: alice("secret.txt"),
          owner: "alice",
          ownerHome: alice(),
          writable: true,
        },
        {
          name: "Projects",
          dir: alice("Projects"),
          owner: "alice",
          ownerHome: alice(),
          writable: true,
        },
      ],
    });
    expect((await odd.list(`/${SHARED_WITH_ME}`)).map((entry) => entry.name)).toEqual(["Projects"]);
    const zip = await zipEntries(await odd.zip([`/${SHARED_WITH_ME}`]));
    expect(zip.map((entry) => entry.name)).toContain(`${SHARED_WITH_ME}/Projects/brief.txt`);
  });

  it("never creates again a shared folder its owner removed", async () => {
    const gone = createUserStorage({
      home: join(root, "bob"),
      shared: async () => [
        {
          name: "Gone",
          dir: alice("Gone", "deeper"),
          owner: "alice",
          ownerHome: alice(),
          writable: true,
        },
      ],
    });
    const inside = `/${SHARED_WITH_ME}/Gone/new`;
    expect(await kindOf(gone.mkdir(inside, { parents: true }))).toBe("not_found");
    expect(await kindOf(gone.upload(`${inside}/x.txt`, bytes("x"), { mkdirParents: true }))).toBe(
      "not_found",
    );
    expect(await kindOf(gone.move("/own.txt", `${inside}.txt`))).toBe("not_found");
    await expect(stat(alice("Gone"))).rejects.toThrow();
  });

  it("reads inside a shared folder at the paths the user sees", async () => {
    const entries = await bob.list(`/${SHARED_WITH_ME}/Projects`);
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      `/${SHARED_WITH_ME}/Projects/brief.txt`,
      `/${SHARED_WITH_ME}/Projects/plans`,
    ]);
    expect(await read(bob, `/${SHARED_WITH_ME}/Projects/brief.txt`)).toBe("brief");
    expect(await bob.statFile(`/${SHARED_WITH_ME}/Photos/cat.jpg`)).toMatchObject({ size: 3 });
    await expect(bob.probeDirectoryRead(`/${SHARED_WITH_ME}`)).resolves.toBeUndefined();
    await expect(bob.probeDirectoryRead(`/${SHARED_WITH_ME}/Projects`)).resolves.toBeUndefined();
  });

  it("refuses to read a shared folder that does not exist or Shared with me as a file", async () => {
    expect(await kindOf(bob.list(`/${SHARED_WITH_ME}/Nope`))).toBe("not_found");
    expect(await kindOf(bob.stat(`/${SHARED_WITH_ME}/Nope/x`))).toBe("not_found");
    expect(await kindOf(bob.statFile(`/${SHARED_WITH_ME}`))).toBe("bad_request");
    expect(await kindOf(bob.download(`/${SHARED_WITH_ME}`))).toBe("bad_request");
  });

  it("refuses a shared folder its owner replaced with a link", async () => {
    await mkdir(join(root, "elsewhere"));
    await writeFile(join(root, "elsewhere", "private.txt"), "private");
    await symlink(join(root, "elsewhere"), alice("Linked"));
    await symlink(alice(".trash"), alice("Bin link"));
    const linked = createUserStorage({
      home: join(root, "bob"),
      shared: async () => [
        {
          name: "Linked",
          dir: alice("Linked"),
          owner: "alice",
          ownerHome: alice(),
          writable: true,
        },
        {
          name: "Bin link",
          dir: alice("Bin link"),
          owner: "alice",
          ownerHome: alice(),
          writable: true,
        },
      ],
    });
    expect(await kindOf(linked.list(`/${SHARED_WITH_ME}/Linked`))).toBe("forbidden");
    expect(await kindOf(linked.download(`/${SHARED_WITH_ME}/Linked/private.txt`))).toBe(
      "forbidden",
    );
    expect(await kindOf(linked.list(`/${SHARED_WITH_ME}/Bin link`))).toBe("forbidden");
    expect((await linked.list(`/${SHARED_WITH_ME}`)).map((entry) => entry.name)).toEqual([]);
  });

  it("keeps a shared folder's links unfollowed, even to its own files", async () => {
    await symlink(alice("secret.txt"), alice("Projects", "leak.txt"));
    await symlink(alice("Projects", "brief.txt"), alice("Projects", "brief-link.txt"));
    expect(await kindOf(bob.download(`/${SHARED_WITH_ME}/Projects/leak.txt`))).toBe("forbidden");
    expect(await kindOf(bob.download(`/${SHARED_WITH_ME}/Projects/brief-link.txt`))).toBe(
      "forbidden",
    );
  });

  it("writes into a writable shared folder on its owner's disk", async () => {
    const inShare = (path: string) => `/${SHARED_WITH_ME}/Projects${path}`;
    await bob.upload(inShare("/new.txt"), bytes("new"), {
      modifiedAt: new Date("2020-01-01T00:00:00Z"),
    });
    await bob.mkdir(inShare("/a/b"), { parents: true });
    expect(await readFile(alice("Projects", "new.txt"), "utf8")).toBe("new");
    expect((await stat(alice("Projects", "new.txt"))).mtime.toISOString()).toBe(
      "2020-01-01T00:00:00.000Z",
    );
    expect((await stat(alice("Projects", "a", "b"))).isDirectory()).toBe(true);
    await bob.move(inShare("/new.txt"), inShare("/a/renamed.txt"));
    await bob.copy(inShare("/a/renamed.txt"), inShare("/copy.txt"));
    await bob.deleteFile(inShare("/a/renamed.txt"));
    await bob.deleteEmptyDir(inShare("/a/b"));
    await bob.deleteDir(inShare("/a"));
    expect(await names(inShare(""))).toEqual(["brief.txt", "copy.txt", "plans"]);
  });

  it("refuses every change to a read-only shared folder but lets the user copy out", async () => {
    const photo = `/${SHARED_WITH_ME}/Photos/cat.jpg`;
    for (const change of [
      bob.upload(`/${SHARED_WITH_ME}/Photos/x.jpg`, bytes("x")),
      bob.mkdir(`/${SHARED_WITH_ME}/Photos/new`),
      bob.deleteFile(photo),
      bob.deleteDir(`/${SHARED_WITH_ME}/Photos/sub`),
      bob.deleteEmptyDir(`/${SHARED_WITH_ME}/Photos/sub`),
      bob.move(photo, "/cat.jpg"),
      bob.move("/own.txt", `/${SHARED_WITH_ME}/Photos/own.txt`),
      bob.copy("/own.txt", `/${SHARED_WITH_ME}/Photos/own.txt`),
    ]) {
      expect(await kindOf(change)).toBe("forbidden");
    }
    await bob.copy(photo, "/cat.jpg");
    expect(await read(bob, "/cat.jpg")).toBe("cat");
    expect(await readFile(alice("Photos", "cat.jpg"), "utf8")).toBe("cat");
  });

  it("keeps Shared with me and the shared folders themselves fixed", async () => {
    const shelf = `/${SHARED_WITH_ME}`;
    const folder = `${shelf}/Projects`;
    for (const change of [
      bob.deleteDir(shelf),
      bob.deleteDir(folder),
      bob.deleteEmptyDir(shelf),
      bob.deleteEmptyDir(folder),
      bob.deleteFile(shelf),
      bob.move(folder, "/Projects"),
      bob.move(shelf, "/elsewhere"),
      bob.move("/own.txt", folder),
      bob.upload(`${shelf}/new.txt`, bytes("x")),
      bob.upload(`${shelf}/Nope/new.txt`, bytes("x")),
      bob.mkdir(shelf),
      bob.mkdir(`${shelf}/Nope`, { parents: true }),
      bob.copy(shelf, "/copy"),
    ]) {
      expect(await kindOf(change)).toBe("forbidden");
    }
    expect(await kindOf(bob.deleteFile(`${shelf}/Nope`))).toBe("not_found");
    expect(await bob.mkdir(shelf, { parents: true })).toMatchObject({
      path: shelf,
      name: SHARED_WITH_ME,
      kind: "dir",
      ino: 0n,
      created: null,
    });
    expect(await bob.mkdir(folder, { parents: true })).toMatchObject({
      path: folder,
      name: "Projects",
      kind: "dir",
      created: null,
    });
  });

  it("moves and copies between the user's files and a shared folder in one step", async () => {
    const folder = `/${SHARED_WITH_ME}/Projects`;
    await bob.move("/own.txt", `${folder}/own.txt`);
    expect(await readFile(alice("Projects", "own.txt"), "utf8")).toBe("own");
    expect(await kindOf(bob.stat("/own.txt"))).toBe("not_found");
    await bob.move(`${folder}/own.txt`, "/back/own.txt");
    expect(await read(bob, "/back/own.txt")).toBe("own");
    await bob.copy(`${folder}/plans`, "/plans-copy");
    await bob.copy("/back/own.txt", `${folder}/copied.txt`);
    expect(await readFile(alice("Projects", "copied.txt"), "utf8")).toBe("own");
    expect(await names("/plans-copy")).toEqual([]);
    await bob.copy(folder, "/whole");
    expect(await names("/whole")).toEqual(["brief.txt", "copied.txt", "plans"]);
    expect(await kindOf(bob.move(`${folder}/brief.txt`, "/back/own.txt"))).toBe("conflict");
    expect(await kindOf(bob.move("/", `${folder}/home`))).toBe("not_found");
    expect(await kindOf(bob.copy("/", `${folder}/home`))).toBe("not_found");
    expect(await kindOf(bob.move(`${folder}/missing`, "/x"))).toBe("not_found");
  });

  it("zips the user's files, a shared folder by its name and all of Shared with me", async () => {
    const zip = await zipEntries(
      await bob.zip([
        "/own.txt",
        `/${SHARED_WITH_ME}/Photos`,
        `/${SHARED_WITH_ME}/Projects/brief.txt`,
      ]),
    );
    expect(zip.map((entry) => entry.name).sort()).toEqual([
      "Photos/cat.jpg",
      "brief.txt",
      "own.txt",
    ]);
    const all = await zipEntries(await bob.zip([`/${SHARED_WITH_ME}`]));
    expect(all.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        `${SHARED_WITH_ME}/Photos/cat.jpg`,
        `${SHARED_WITH_ME}/Projects/brief.txt`,
      ]),
    );
    expect(await kindOf(bob.zip([`/${SHARED_WITH_ME}/Nope`]))).toBe("not_found");
  });
});

describe("createUserStorage with a storage limit", () => {
  /** Bob's storage, with `left` bytes of room for each owner. */
  function limited(left: Readonly<Record<string, number | null>>) {
    const room = vi.fn(async (folder: SharedFolder | null) => left[folder?.owner ?? "bob"] ?? null);
    return { room, storage: createUserStorage({ home: join(root, "bob"), shared, room }) };
  }
  const folder = `/${SHARED_WITH_ME}/Projects`;

  it("refuses an upload with more bytes than its owner has room for, and writes nothing", async () => {
    const { storage } = limited({ bob: 5 });
    expect(await kindOf(storage.upload("/big.txt", bytes("123456")))).toBe("storage_limit_reached");
    expect(await kindOf(storage.upload("/big.txt", streamOf(["1234", "56"])))).toBe(
      "storage_limit_reached",
    );
    expect(await names("/")).toEqual([SHARED_WITH_ME, "own.txt"]);
    await storage.upload("/fits.txt", streamOf(["12", "345"]));
    expect(await read(storage, "/fits.txt")).toBe("12345");
  });

  it("counts the pieces an upload sent in pieces has already written against the room", async () => {
    const { storage } = limited({ bob: 6 });
    const piece = (offset: number) => ({ part: { id: "0123456789abcdef", offset } });
    await storage.uploadPart("/pieces.txt", bytes("1234"), piece(0));
    // Four bytes are already in the part, so a piece of three is one too many.
    expect(await kindOf(storage.upload("/pieces.txt", bytes("567"), piece(4)))).toBe(
      "storage_limit_reached",
    );
    expect(await kindOf(storage.uploadPart("/pieces.txt", bytes("x"), piece(7)))).toBe(
      "storage_limit_reached",
    );
    await storage.upload("/pieces.txt", bytes("56"), piece(4));
    expect(await read(storage, "/pieces.txt")).toBe("123456");
  });

  it("refuses every write once its owner is over the limit, but not where there is none", async () => {
    expect(await kindOf(limited({ bob: -1 }).storage.upload("/empty.txt", bytes("")))).toBe(
      "storage_limit_reached",
    );
    await limited({ bob: null }).storage.upload("/free.txt", bytes("anything"));
    expect(await read(bob, "/free.txt")).toBe("anything");
  });

  it("counts a replaced file's bytes as freed", async () => {
    const { storage } = limited({ bob: 1 });
    // own.txt holds 3 bytes; replacing it with 4 adds one. Nothing is freed at a new name.
    expect(await kindOf(storage.upload("/new.txt", bytes("ab"), { overwrite: true }))).toBe(
      "storage_limit_reached",
    );
    await storage.upload("/own.txt", bytes("four"), { overwrite: true });
    expect(await read(storage, "/own.txt")).toBe("four");
    expect(await kindOf(storage.upload("/own.txt", bytes("sixsix"), { overwrite: true }))).toBe(
      "storage_limit_reached",
    );
  });

  it("counts a write in a shared folder against the folder's owner", async () => {
    const { room, storage } = limited({ bob: 0, alice: 100 });
    await storage.upload(`${folder}/note.txt`, bytes("note"));
    expect(await readFile(alice("Projects", "note.txt"), "utf8")).toBe("note");
    expect(room).toHaveBeenLastCalledWith(expect.objectContaining({ owner: "alice" }));
    expect(await kindOf(storage.upload("/note.txt", bytes("note")))).toBe("storage_limit_reached");
  });

  it("refuses a copy of more bytes than the target's owner has room for", async () => {
    await writeFile(alice("Projects", "plans", "plan.txt"), "plan");
    await symlink(alice("secret.txt"), alice("Projects", "plans", "link"));
    const { storage } = limited({ bob: 8, alice: 0 });
    // brief.txt (5) and plans/plan.txt (4) are 9 bytes; a link counts as nothing.
    expect(await kindOf(storage.copy(folder, "/whole"))).toBe("storage_limit_reached");
    expect(await kindOf(storage.copy("/own.txt", `${folder}/own.txt`))).toBe(
      "storage_limit_reached",
    );
    await storage.copy(`${folder}/plans`, "/plans");
    expect(await names("/plans")).toEqual(["link", "plan.txt"]);
    expect(await kindOf(storage.copy(`${folder}/missing`, "/x"))).toBe("not_found");
  });

  it("refuses a move into another owner's files they have no room for, and nothing else", async () => {
    const { room, storage } = limited({ bob: 0, alice: 2 });
    // own.txt holds 3 bytes; alice has room for 2.
    expect(await kindOf(storage.move("/own.txt", `${folder}/own.txt`))).toBe(
      "storage_limit_reached",
    );
    expect(await read(storage, "/own.txt")).toBe("own");
    // Within one owner's files a move adds nothing, so bob's own limit is not asked.
    room.mockClear();
    await storage.move("/own.txt", "/kept.txt");
    await storage.move(`${folder}/brief.txt`, `${folder}/plans/brief.txt`);
    expect(room).not.toHaveBeenCalled();
    // Out of alice's files into bob's: brief.txt is 5 bytes and bob has no room.
    expect(await kindOf(storage.move(`${folder}/plans/brief.txt`, "/brief.txt"))).toBe(
      "storage_limit_reached",
    );
    const roomy = limited({ bob: 10, alice: 10 }).storage;
    await roomy.move("/kept.txt", `${folder}/kept.txt`);
    expect(await readFile(alice("Projects", "kept.txt"), "utf8")).toBe("own");
  });
});

describe("createUserStorage: Trash", () => {
  const ID = "0d9f8a52-6c1e-4f53-9a7b-2e4c6d8f0a1b";
  const OTHER = "7a4b2c1d-3e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const bobStorage = () => createUserStorage({ home: join(root, "bob"), shared });
  const aliceStorage = () => createUserStorage({ home: alice(), shared: async () => [] });

  it("moves the user's own item into their Trash at /.trash", async () => {
    const leaf = `/.trash/${ID}/own.txt`;
    expect(await bobStorage().trash.put("/own.txt", ID)).toEqual({ leaf, kind: "file" });
    expect(await readFile(join(root, "bob", leaf), "utf8")).toBe("own");
  });

  it("moves an item in a writable shared folder into its owner's Trash, where only the owner finds it", async () => {
    const leaf = `/.trash/${ID}/plans`;
    const storage = bobStorage();
    expect(await storage.trash.put(`/${SHARED_WITH_ME}/Projects/plans`, ID)).toEqual({
      leaf,
      kind: "dir",
    });
    expect((await stat(alice(leaf))).isDirectory()).toBe(true);
    expect(await kindOf(bob.stat(`/${SHARED_WITH_ME}/Projects/plans`))).toBe("not_found");
    // The person it is shared with cannot purge it; its owner restores it.
    await storage.trash.purge(ID);
    expect((await stat(alice(leaf))).isDirectory()).toBe(true);
    await aliceStorage().trash.restore(ID, "plans", "/Projects/plans");
    expect((await stat(alice("Projects", "plans"))).isDirectory()).toBe(true);
  });

  it("refuses what the person it is shared with may not change", async () => {
    const storage = bobStorage();
    for (const path of [
      `/${SHARED_WITH_ME}`,
      `/${SHARED_WITH_ME}/Projects`,
      `/${SHARED_WITH_ME}/Photos/cat.jpg`,
      `/${SHARED_WITH_ME}/Nowhere/x`,
    ]) {
      expect(await kindOf(storage.trash.put(path, ID)), path).toBe("forbidden");
    }
    expect(await readFile(alice("Photos", "cat.jpg"), "utf8")).toBe("cat");
  });

  it("restores an item into a shared folder the user may change", async () => {
    const storage = bobStorage();
    await storage.trash.put("/own.txt", OTHER);
    await storage.trash.restore(OTHER, "own.txt", `/${SHARED_WITH_ME}/Projects/own.txt`);
    expect(await readFile(alice("Projects", "own.txt"), "utf8")).toBe("own");
  });
});
