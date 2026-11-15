import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageError } from "@fdrive/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytes, kindOf } from "../test/helpers.js";
import {
  createFilesFolder,
  isLocalUsername,
  type LocalUserStatus,
  type LocalUsers,
  probeRoot,
} from "./files-folder.js";
import { createFilesFolderGuard, FILES_FOLDER_REASONS } from "./files-marker.js";
import { SHARED_WITH_ME, type SharedGrant } from "./shared.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fdrive-local-module-"));
});

afterEach(async () => {
  await chmod(root, 0o700);
  await rm(root, { recursive: true, force: true });
});

function users(
  status: LocalUserStatus | Error = "active",
  grants: readonly SharedGrant[] = [],
): LocalUsers {
  return {
    status: vi.fn(async () => {
      if (status instanceof Error) throw status;
      return status;
    }),
    shared: vi.fn(async () => grants),
  };
}

describe("isLocalUsername", () => {
  it.each(["alice", "Bob.Smith", "c-d_e", "f@example.com", "g~h", "1"])("accepts %s", (name) => {
    expect(isLocalUsername(name)).toBe(true);
  });

  it.each(["", ".hidden", "-dash", "a/b", "..", "a b", "ä", "x".repeat(256)])(
    "refuses %j",
    (name) => {
      expect(isLocalUsername(name)).toBe(false);
    },
  );
});

describe("probeRoot", () => {
  it("accepts a writable folder", async () => {
    expect(await probeRoot(root)).toEqual({ ok: true, detail: expect.any(String) });
  });

  it("refuses a file, a missing path and a read-only folder", async () => {
    await writeFile(join(root, "file"), "x");
    expect((await probeRoot(join(root, "file"))).ok).toBe(false);
    expect((await probeRoot(join(root, "missing"))).ok).toBe(false);
    const readOnly = join(root, "read-only");
    await mkdir(readOnly);
    await chmod(readOnly, 0o500);
    // Root ignores permission bits, so only a normal user can see this one.
    if (process.getuid?.() !== 0) expect((await probeRoot(readOnly)).ok).toBe(false);
    await chmod(readOnly, 0o700);
  });
});

describe("createFilesFolder", () => {
  it("is healthy while the root is a writable folder", async () => {
    expect(await createFilesFolder({ root, users: users() }).health()).toEqual({
      ok: true,
      detail: expect.any(String),
    });
    const missing = createFilesFolder({ root: join(root, "missing"), users: users() });
    expect((await missing.health()).ok).toBe(false);
  });

  it("admits only active users", async () => {
    await expect(createFilesFolder({ root, users: users() }).admit("alice")).resolves.toBe(
      undefined,
    );
    for (const status of ["disabled", "missing"] as const) {
      const folder = createFilesFolder({ root, users: users(status) });
      expect(await kindOf(folder.admit("alice"))).toBe("forbidden");
    }
    const down = createFilesFolder({ root, users: users(new Error("db down")) });
    expect(await kindOf(down.admit("alice"))).toBe("upstream_unavailable");
  });

  it("gives each user their own home under the root", async () => {
    const folder = createFilesFolder({ root, users: users() });
    const alice = folder.storage("alice");
    const bob = folder.storage("bob");
    await alice.upload("/note.txt", bytes("alice"));
    expect(await bob.list("/")).toEqual([]);
    expect(await kindOf(bob.statFile("/note.txt"))).toBe("not_found");
    expect((await alice.list("/")).map((entry) => entry.name)).toEqual(["note.txt"]);
  });

  it("shows what others share with a user under Shared with me, skipping odd grants", async () => {
    const folder = createFilesFolder({
      root,
      users: users("active", [
        { owner: "alice", path: "/Projects/../Projects", writable: false },
        { owner: "bob", path: "/Mine", writable: true },
        { owner: "../etc", path: "/", writable: true },
      ]),
    });
    const alice = folder.storage("alice");
    await alice.upload("/Projects/plan.txt", bytes("plan"), { mkdirParents: true });
    const bob = folder.storage("bob");
    expect((await bob.list(`/${SHARED_WITH_ME}`)).map((entry) => entry.name)).toEqual(["Projects"]);
    expect(await kindOf(bob.upload(`/${SHARED_WITH_ME}/Projects/x`, bytes("x")))).toBe("forbidden");
  });

  it("counts each write against the owner of the folder it lands in", async () => {
    const room = vi.fn(async (username: string) => (username === "alice" ? 100 : 0));
    const folder = createFilesFolder({
      root,
      users: {
        ...users("active", [{ owner: "alice", path: "/Projects", writable: true }]),
        room,
      },
    });
    const alice = folder.storage("alice");
    await alice.upload("/Projects/plan.txt", bytes("plan"), { mkdirParents: true });
    expect(room).toHaveBeenLastCalledWith("alice");
    const bob = folder.storage("bob");
    expect(await kindOf(bob.upload("/note.txt", bytes("note")))).toBe("storage_limit_reached");
    expect(room).toHaveBeenLastCalledWith("bob");
    await bob.upload(`/${SHARED_WITH_ME}/Projects/note.txt`, bytes("note"));
    expect(room).toHaveBeenLastCalledWith("alice");
  });

  it("refuses a folder shared from its owner's Trash, on, off or renamed since", async () => {
    const closedFolders = vi.fn(async (): Promise<readonly string[]> => ["/Bin"]);
    const folder = createFilesFolder({
      root,
      closedFolders,
      users: users("active", [
        { owner: "alice", path: "/Bin/.fdrive-move-v1/dir/p/Old/v/1", writable: true },
        // In the Trash folder before it was renamed to `/Bin`.
        { owner: "alice", path: "/.trash/.fdrive-move-v1/dir/p/Older/v/2", writable: true },
        { owner: "alice", path: "/Bin/loose", writable: true },
        { owner: "alice", path: "/Bin link", writable: true },
        { owner: "alice", path: "/Projects", writable: true },
      ]),
    });
    const alice = folder.storage("alice");
    await alice.upload("/Bin/.fdrive-move-v1/dir/p/Old/v/1/kept.txt", bytes("kept"), {
      mkdirParents: true,
    });
    await alice.upload("/.trash/.fdrive-move-v1/dir/p/Older/v/2/kept.txt", bytes("kept"), {
      mkdirParents: true,
    });
    await alice.upload("/Bin/loose/kept.txt", bytes("kept"), { mkdirParents: true });
    await alice.upload("/Projects/plan.txt", bytes("plan"), { mkdirParents: true });
    await symlink(join(root, "alice", "Bin"), join(root, "alice", "Bin link"));
    const bob = () => folder.storage("bob");
    const shelf = async () =>
      (await bob().list(`/${SHARED_WITH_ME}`)).map((entry) => entry.name).sort();

    expect(await shelf()).toEqual(["Projects"]);
    expect(closedFolders).toHaveBeenCalled();
    expect(await kindOf(bob().list(`/${SHARED_WITH_ME}/1`))).toBe("not_found");
    expect(await kindOf(bob().list(`/${SHARED_WITH_ME}/2`))).toBe("not_found");
    expect(await kindOf(bob().upload(`/${SHARED_WITH_ME}/1/x`, bytes("x")))).toBe("forbidden");
    expect(await kindOf(bob().list(`/${SHARED_WITH_ME}/Bin link`))).toBe("forbidden");

    // Trash turned off: what is still in fdrive's Trash layout stays out of reach, and a
    // link stays a link.
    closedFolders.mockResolvedValue([]);
    expect(await shelf()).toEqual(["Projects", "loose"]);
  });

  it("asks for the closed folders only when something is shared", async () => {
    const closedFolders = vi.fn(async () => ["/.trash"]);
    const folder = createFilesFolder({ root, closedFolders, users: users() });
    const bob = folder.storage("bob");
    expect(await bob.list("/")).toEqual([]);
    expect(closedFolders).not.toHaveBeenCalled();
  });

  it("refuses to build storage for a name that cannot be a home", () => {
    const folder = createFilesFolder({ root, users: users() });
    expect(() => folder.storage("..")).toThrow(StorageError);
  });

  describe("with a files folder guard", () => {
    const facts = (holds: boolean) => ({
      installationId: async () => "5b0e8b9e-1f3c-4a7d-b2e6-9d4c8a1f0e23",
      holdsFiles: async () => holds,
    });

    it("serves a folder once it has adopted it", async () => {
      await mkdir(join(root, "alice"));
      const guard = createFilesFolderGuard({ root, facts: facts(true) });
      const folder = createFilesFolder({ root, users: users(), guard });
      expect(await folder.storage("alice").list("/")).toEqual([]);
      expect(await folder.health()).toEqual({ ok: true, detail: expect.any(String) });
    });

    it("refuses every operation on a wrong, empty folder, but still admits users", async () => {
      const guard = createFilesFolderGuard({ root, facts: facts(true) });
      const folder = createFilesFolder({ root, users: users(), guard });
      const alice = folder.storage("alice");
      expect(await kindOf(alice.list("/"))).toBe("upstream_unavailable");
      await expect(alice.upload("/x.txt", bytes("x"))).rejects.toThrow(FILES_FOLDER_REASONS.empty);
      expect(await kindOf(alice.stat(`/${SHARED_WITH_ME}`))).toBe("upstream_unavailable");
      await expect(folder.admit("alice")).resolves.toBeUndefined();
      expect(await folder.health()).toEqual({ ok: false, detail: FILES_FOLDER_REASONS.empty });
      expect(await readdir(root)).toEqual([]);
    });
  });
});
