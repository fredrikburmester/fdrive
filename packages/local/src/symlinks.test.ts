import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { StorageProvider } from "@fdrive/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bytes, kindOf, zipEntries } from "../test/helpers.js";
import { createUserStorage, SHARED_WITH_ME } from "./shared.js";

// fdrive never follows a symbolic link: a path through one is refused by
// every operation, however the link got there and wherever it leads.

let root: string;
let alice: StorageProvider;
let bob: StorageProvider;

const inAlice = (...parts: string[]) => join(root, "alice", ...parts);
const SHARED_DOCS = `/${SHARED_WITH_ME}/Docs`;
const PART = { id: "0123456789abcdef", offset: 0 };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "fdrive-symlinks-")));
  await mkdir(inAlice("docs", "sub"), { recursive: true });
  await writeFile(inAlice("docs", "a.txt"), "alpha");
  await writeFile(inAlice("docs", "sub", "b.txt"), "bravo");
  await mkdir(inAlice(".trash"));
  await writeFile(inAlice(".trash", "old.txt"), "deleted");
  await mkdir(inAlice(".fdrive-desktop", "state"), { recursive: true });
  await writeFile(inAlice(".fdrive-desktop", "state", "secret.txt"), "secret");
  // Links an SMB or rsync user left: to an ordinary folder, to the Trash and to the Mac's folder.
  await symlink(inAlice("docs", "sub"), inAlice("docs", "folder"));
  await symlink(inAlice(".trash"), inAlice("docs", "trash"));
  await symlink("../.fdrive-desktop", inAlice("docs", "desk"));
  await mkdir(join(root, "bob"));
  alice = createUserStorage({ home: inAlice(), shared: async () => [] });
  bob = createUserStorage({
    home: join(root, "bob"),
    shared: async () => [
      { name: "Docs", dir: inAlice("docs"), owner: "alice", ownerHome: inAlice(), writable: true },
    ],
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Everything under `dir` as it is on disk, links as links, with contents and times. */
async function snapshot(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name);
    const name = relative(root, at);
    const { mtimeMs } = await lstat(at);
    if (entry.isSymbolicLink()) found.push(`${name} -> ${await readlink(at)}`);
    else if (entry.isDirectory()) found.push(`${name}/ @${mtimeMs}`, ...(await snapshot(at)));
    else found.push(`${name} @${mtimeMs} = ${await readFile(at, "utf8")}`);
  }
  return found.sort();
}

/** Every storage operation on `path`; `file` is an ordinary file beside it. */
function operations(storage: StorageProvider, path: string, file: string) {
  return {
    stat: () => storage.stat(path),
    statFile: () => storage.statFile(path),
    list: () => storage.list(path),
    open: () => storage.open(path),
    contentStamp: () => storage.contentStamp(path),
    probeDirectoryRead: () => storage.probeDirectoryRead(path),
    upload: () => storage.upload(path, bytes("x"), { overwrite: true }),
    "upload inside": () => storage.upload(`${path}/new.txt`, bytes("x"), { mkdirParents: true }),
    uploadPart: () => storage.uploadPart(path, bytes("x"), { part: PART, overwrite: true }),
    mkdir: () => storage.mkdir(path, { parents: true }),
    "mkdir inside": () => storage.mkdir(`${path}/new`, { parents: true }),
    "move from": () => storage.move(path, `${file}-moved`),
    "move to": () => storage.move(file, path, { overwrite: true }),
    "move out": () => storage.move(path, "/moved"),
    "copy from": () => storage.copy(path, `${file}-copied`),
    "copy to": () => storage.copy(file, path, { overwrite: true }),
    "copy out": () => storage.copy(path, "/copied"),
    deleteFile: () => storage.deleteFile(path),
    deleteDir: () => storage.deleteDir(path),
    deleteEmptyDir: () => storage.deleteEmptyDir(path),
    zip: () => storage.zip([path]),
  };
}

const views = [
  { who: "in the user's own files", storage: () => alice, docs: "/docs" },
  { who: "inside Shared with me", storage: () => bob, docs: SHARED_DOCS },
];

const links = [
  { to: "an ordinary folder", link: "folder", end: "folder", middle: "folder/b.txt" },
  { to: "the Trash", link: "trash", end: "trash", middle: "trash/old.txt" },
  { to: "the Mac's folder", link: "desk", end: "desk", middle: "desk/state/secret.txt" },
];

describe.each(views)("a path through a symlink $who", ({ storage, docs }) => {
  it.each(links)("is refused for every operation, to $to", async ({ end, middle }) => {
    const before = await snapshot(root);
    for (const path of [`${docs}/${end}`, `${docs}/${middle}`]) {
      const refused = Object.fromEntries(
        await Promise.all(
          Object.entries(operations(storage(), path, `${docs}/a.txt`)).map(
            async ([name, run]) => [name, await kindOf(run())] as const,
          ),
        ),
      );
      expect(refused, path).toEqual(
        Object.fromEntries(Object.keys(refused).map((name) => [name, "forbidden"])),
      );
    }
    expect(await snapshot(root)).toEqual(before);
  });

  it("is listed as a symlink, which the user sees but cannot open", async () => {
    const entries = await storage().list(docs);
    expect(Object.fromEntries(entries.map((entry) => [entry.name, entry.kind]))).toEqual({
      "a.txt": "file",
      desk: "symlink",
      folder: "symlink",
      sub: "dir",
      trash: "symlink",
    });
    expect(entries.find((entry) => entry.name === "trash")).toMatchObject({ size: 0 });
  });

  it("is left out of a zip of its folder", async () => {
    const zip = await zipEntries(await storage().zip([docs]));
    const name = docs === "/docs" ? "docs" : "Docs";
    expect(zip.map((entry) => entry.name).sort()).toEqual([`${name}/a.txt`, `${name}/sub/b.txt`]);
  });

  it("goes along as the link it is when its folder is copied or moved", async () => {
    const before = await snapshot(inAlice(".trash"));
    await storage().copy(docs, "/copy");
    await storage().move("/copy", "/moved");
    const home = storage() === alice ? inAlice() : join(root, "bob");
    for (const name of ["folder", "trash", "desk"]) {
      expect(await readlink(join(home, "moved", name))).toBe(await readlink(inAlice("docs", name)));
    }
    expect(await readdir(join(home, "moved"))).toEqual(
      expect.arrayContaining(["a.txt", "sub", "folder", "trash", "desk"]),
    );
    expect(await kindOf(storage().list("/moved/trash"))).toBe("forbidden");
    expect(await snapshot(inAlice(".trash"))).toEqual(before);
  });
});

describe("a shared folder whose own path passes through a symlink", () => {
  it("is refused when used, and left out of Shared with me", async () => {
    await symlink(inAlice("docs"), inAlice("alias"));
    const shelf = createUserStorage({
      home: join(root, "bob"),
      shared: async () => [
        {
          name: "Alias",
          dir: inAlice("alias"),
          owner: "alice",
          ownerHome: inAlice(),
          writable: true,
        },
        {
          name: "Sub",
          dir: inAlice("alias", "sub"),
          owner: "alice",
          ownerHome: inAlice(),
          writable: true,
        },
        {
          name: "Trash",
          dir: inAlice("docs", "trash"),
          owner: "alice",
          ownerHome: inAlice(),
          writable: true,
        },
      ],
    });
    for (const name of ["Alias", "Sub", "Trash"]) {
      expect(await kindOf(shelf.list(`/${SHARED_WITH_ME}/${name}`)), name).toBe("forbidden");
      expect(await kindOf(shelf.upload(`/${SHARED_WITH_ME}/${name}/x.txt`, bytes("x"))), name).toBe(
        "forbidden",
      );
    }
    expect(await shelf.list(`/${SHARED_WITH_ME}`)).toEqual([]);
    expect(await zipEntries(await shelf.zip([`/${SHARED_WITH_ME}`]))).toEqual([]);
  });
});
