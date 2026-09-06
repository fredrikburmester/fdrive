import { describe, expect, it } from "vitest";
import { SEED_FOLDERS, SEED_USERS } from "./seed-data.js";
import { buildSftpgoDump } from "./sftpgo-dump.js";

describe("buildSftpgoDump", () => {
  it("maps each user to a dump user with a home dir under dataDir", () => {
    const dump = buildSftpgoDump(SEED_USERS, SEED_FOLDERS, { dataDir: "/srv/sftpgo/data" });

    expect(dump.users).toHaveLength(SEED_USERS.length);
    const alice = dump.users.find((user) => user.username === "alice");
    expect(alice).toEqual({
      username: "alice",
      password: "alice-password",
      status: 1,
      home_dir: "/srv/sftpgo/data/alice",
      permissions: { "/": ["*"] },
      virtual_folders: [],
    });
  });

  it("carries permissions through unchanged", () => {
    const dump = buildSftpgoDump(SEED_USERS, SEED_FOLDERS, { dataDir: "/srv/sftpgo/data" });

    const bob = dump.users.find((user) => user.username === "bob");
    expect(bob?.permissions).toEqual({
      "/": ["list", "download"],
      "/inbox": ["list", "upload", "create_dirs"],
    });
  });

  it("converts a user's virtualFolders into dump virtual_folders", () => {
    const dump = buildSftpgoDump(SEED_USERS, SEED_FOLDERS, { dataDir: "/srv/sftpgo/data" });

    const carol = dump.users.find((user) => user.username === "carol");
    expect(carol?.virtual_folders).toEqual([{ name: "shared", virtual_path: "/shared" }]);
  });

  it("defaults virtual_folders to an empty array when a user has none", () => {
    const dump = buildSftpgoDump(
      [{ username: "dave", password: "dave-password", permissions: { "/": ["*"] } }],
      [],
      { dataDir: "/srv/sftpgo/data" },
    );

    expect(dump.users[0]?.virtual_folders).toEqual([]);
  });

  it("maps each folder to a mapped_path under dataDir/_folders", () => {
    const dump = buildSftpgoDump(SEED_USERS, SEED_FOLDERS, { dataDir: "/srv/sftpgo/data" });

    expect(dump.folders).toEqual([
      { name: "shared", mapped_path: "/srv/sftpgo/data/_folders/shared" },
    ]);
  });

  it("returns empty arrays when given no users or folders", () => {
    const dump = buildSftpgoDump([], [], { dataDir: "/srv/sftpgo/data" });

    expect(dump).toEqual({ users: [], folders: [] });
  });

  it("is pure: calling it twice with the same input yields equal but distinct results", () => {
    const opts = { dataDir: "/srv/sftpgo/data" };
    const first = buildSftpgoDump(SEED_USERS, SEED_FOLDERS, opts);
    const second = buildSftpgoDump(SEED_USERS, SEED_FOLDERS, opts);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
