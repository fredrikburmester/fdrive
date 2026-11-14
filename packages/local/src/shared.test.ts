import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytes, kindOf, read, zipEntries } from "../test/helpers.js";
import {
  closedToShares,
  createUserStorage,
  SHARED_WITH_ME,
  type SharedFolder,
  sharedFolderNames,
  type UserStorage,
} from "./shared.js";

let root: string;
let bob: UserStorage;
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
    { name: "Projects", dir: alice("Projects"), ownerHome: alice(), writable: true },
    { name: "Photos", dir: alice("Photos"), ownerHome: alice(), writable: false },
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
  it("closes the folders given and fdrive's Trash layout wherever it is", () => {
    const closed = ["/.trash", "/.fdrive-desktop"];
    expect(closedToShares("/.trash", closed)).toBe(true);
    expect(closedToShares("/.trash/.fdrive-move-v1/dir/p/Old/v/1", closed)).toBe(true);
    expect(closedToShares("/.fdrive-desktop/id/trash/Old", closed)).toBe(true);
    // Trash turned off or moved: what is still in the old one stays closed.
    expect(closedToShares("/.trash/.fdrive-move-v1/dir/p/Old/v/1/sub", [])).toBe(true);
    expect(closedToShares("/Bin/.fdrive-move-v1/dir/p/Old/v/1", ["/.trash"])).toBe(true);
    expect(closedToShares("/.trash/Old", [])).toBe(false);
    expect(closedToShares("/.trashy/Old", closed)).toBe(false);
    expect(closedToShares("/Projects", closed)).toBe(false);
  });
});

describe("createUserStorage", () => {
  it("lists Shared with me beside the user's own files and asks for shares once", async () => {
    expect(await names("/")).toEqual([SHARED_WITH_ME, "own.txt"]);
    expect(await names(`/${SHARED_WITH_ME}`)).toEqual(["Photos", "Projects"]);
    expect(await bob.stat(`/${SHARED_WITH_ME}`)).toMatchObject({ kind: "dir" });
    expect(shared).toHaveBeenCalledTimes(1);
  });

  it("hides a real folder of the same name while something is shared, and only then", async () => {
    await mkdir(join(root, "bob", SHARED_WITH_ME));
    expect((await bob.list("/")).filter((entry) => entry.name === SHARED_WITH_ME)).toHaveLength(1);
    const alone = createUserStorage({ home: join(root, "bob"), shared: async () => [] });
    await alone.upload(`/${SHARED_WITH_ME}/mine.txt`, bytes("mine"));
    expect((await alone.list(`/${SHARED_WITH_ME}`)).map((entry) => entry.name)).toEqual([
      "mine.txt",
    ]);
  });

  it("leaves out a shared folder its owner removed or that is not a folder", async () => {
    const odd = createUserStorage({
      home: join(root, "bob"),
      shared: async () => [
        { name: "Gone", dir: alice("Gone"), ownerHome: alice(), writable: true },
        { name: "File", dir: alice("secret.txt"), ownerHome: alice(), writable: true },
        { name: "Projects", dir: alice("Projects"), ownerHome: alice(), writable: true },
      ],
    });
    expect((await odd.list(`/${SHARED_WITH_ME}`)).map((entry) => entry.name)).toEqual(["Projects"]);
    const zip = await zipEntries(await odd.zip([`/${SHARED_WITH_ME}`]));
    expect(zip.map((entry) => entry.name)).toContain(`${SHARED_WITH_ME}/Projects/brief.txt`);
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

  it("refuses a shared folder its owner replaced with a link out of their files", async () => {
    await mkdir(join(root, "elsewhere"));
    await writeFile(join(root, "elsewhere", "private.txt"), "private");
    await symlink(join(root, "elsewhere"), alice("Linked"));
    const linked = createUserStorage({
      home: join(root, "bob"),
      shared: async () => [
        { name: "Linked", dir: alice("Linked"), ownerHome: alice(), writable: true },
      ],
    });
    expect(await kindOf(linked.list(`/${SHARED_WITH_ME}/Linked`))).toBe("forbidden");
    expect(await kindOf(linked.download(`/${SHARED_WITH_ME}/Linked/private.txt`))).toBe(
      "forbidden",
    );
    expect((await linked.list(`/${SHARED_WITH_ME}`)).map((entry) => entry.name)).toEqual([]);
  });

  it("refuses a shared folder in its owner's Trash, however the path reaches it", async () => {
    const trashed = alice(".trash", ".fdrive-move-v1", "dir", "p", "Old", "v", "1");
    await mkdir(trashed, { recursive: true });
    await writeFile(join(trashed, "kept.txt"), "kept");
    await symlink(alice(".trash"), alice("Bin link"));
    await mkdir(alice(".fdrive-desktop", "id", "trash", "Mac"), { recursive: true });
    const mounted = (folders: { name: string; dir: string }[], closed?: string[]) =>
      createUserStorage({
        home: join(root, "bob"),
        shared: async () =>
          folders.map((folder) => ({
            ...folder,
            ownerHome: alice(),
            writable: true,
            ...(closed === undefined ? {} : { closed }),
          })),
      });
    const folders = [
      { name: "Old", dir: trashed },
      { name: "Linked", dir: alice("Bin link") },
      { name: "Mac", dir: alice(".fdrive-desktop", "id", "trash", "Mac") },
      { name: "Projects", dir: alice("Projects") },
    ];
    const guarded = mounted(folders, [alice(".trash"), alice(".fdrive-desktop")]);
    expect(await kindOf(guarded.list(`/${SHARED_WITH_ME}/Old`))).toBe("forbidden");
    expect(await kindOf(guarded.download(`/${SHARED_WITH_ME}/Old/kept.txt`))).toBe("forbidden");
    expect(await kindOf(guarded.upload(`/${SHARED_WITH_ME}/Old/new.txt`, bytes("x")))).toBe(
      "forbidden",
    );
    expect(await kindOf(guarded.list(`/${SHARED_WITH_ME}/Linked`))).toBe("forbidden");
    expect(await kindOf(guarded.list(`/${SHARED_WITH_ME}/Mac`))).toBe("forbidden");
    expect((await guarded.list(`/${SHARED_WITH_ME}`)).map((entry) => entry.name)).toEqual([
      "Projects",
    ]);
    await expect(stat(join(trashed, "new.txt"))).rejects.toThrow();

    // Only the folders given count, and one that does not exist rules nothing out.
    const elsewhere = mounted(folders, [alice("Bin")]);
    expect((await elsewhere.list(`/${SHARED_WITH_ME}`)).map((entry) => entry.name).sort()).toEqual([
      "Linked",
      "Mac",
      "Old",
      "Projects",
    ]);
    expect((await mounted(folders).list(`/${SHARED_WITH_ME}/Old`)).map((e) => e.name)).toEqual([
      "kept.txt",
    ]);
  });

  it("keeps a shared folder's links inside it", async () => {
    await symlink(alice("secret.txt"), alice("Projects", "leak.txt"));
    expect(await kindOf(bob.download(`/${SHARED_WITH_ME}/Projects/leak.txt`))).toBe("forbidden");
  });

  it("writes into a writable shared folder on its owner's disk", async () => {
    const inShare = (path: string) => `/${SHARED_WITH_ME}/Projects${path}`;
    await bob.upload(inShare("/new.txt"), bytes("new"));
    await bob.mkdir(inShare("/a/b"), { parents: true });
    await bob.setModifiedAt(inShare("/new.txt"), new Date("2020-01-01T00:00:00Z"));
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
      bob.setModifiedAt(photo, new Date()),
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
      bob.setModifiedAt(shelf, new Date()),
      bob.setModifiedAt(folder, new Date()),
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
    await expect(bob.mkdir(shelf, { parents: true })).resolves.toBeUndefined();
    await expect(bob.mkdir(folder, { parents: true })).resolves.toBeUndefined();
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
