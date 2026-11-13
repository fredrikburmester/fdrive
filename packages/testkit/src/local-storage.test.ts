import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { insertLocalUsers, type LocalUserRepos, startLocalStorage } from "./local-storage.js";
import { SEED_FILES, SEED_GRANTS, SEED_USERS } from "./seed-data.js";

async function started(...args: Parameters<typeof startLocalStorage>) {
  const storage = await startLocalStorage(...args);
  onTestFinished(() => storage.stop());
  return storage;
}

describe("startLocalStorage", () => {
  it("lays the seed out as a home per user, with the seed's grants", async () => {
    const storage = await started();

    expect(storage.users).toBe(SEED_USERS);
    expect(storage.grants).toBe(SEED_GRANTS);
    expect((await readdir(storage.root)).sort()).toEqual(["alice", "bob", "carol"]);
    expect(await readFile(storage.path("alice", "/docs/readme.md"), "utf8")).toBe(
      SEED_FILES.alice?.["/docs/readme.md"],
    );
    expect(await readFile(join(storage.root, "bob", "inbox", ".keep"), "utf8")).toBe("");
    expect(storage.path("carol")).toBe(join(storage.root, "carol", "/"));
  });

  it("takes users and files of its own and then shares nothing unless told", async () => {
    const storage = await started({
      users: [{ username: "dave", password: "dave-pass" }],
      files: { dave: { "/a/b/c.txt": "deep" }, erin: { "/loose.txt": "no user" } },
    });

    expect(storage.grants).toEqual([]);
    expect(await readFile(storage.path("dave", "/a/b/c.txt"), "utf8")).toBe("deep");
    // Files of an owner who is not a user are still laid out; homes exist for users only.
    expect(await readFile(storage.path("erin", "/loose.txt"), "utf8")).toBe("no user");
    expect((await readdir(storage.root)).sort()).toEqual(["dave", "erin"]);

    const shared = await started({
      users: [],
      files: {},
      grants: [{ owner: "a", path: "/x", grantee: "b", access: "read" }],
    });
    expect(shared.grants).toEqual([{ owner: "a", path: "/x", grantee: "b", access: "read" }]);
  });

  it("removes its folder on stop, and when laying out the files fails", async () => {
    const storage = await startLocalStorage({ users: [], files: { alice: { "/x.txt": "x" } } });
    await storage.stop();
    expect(existsSync(storage.root)).toBe(false);

    // A file and a folder at the same path cannot both be laid out.
    await expect(
      startLocalStorage({ users: [], files: { alice: { "/x": "file", "/x/y.txt": "child" } } }),
    ).rejects.toThrow();
  });

  it("returns a real path that stays writable", async () => {
    const storage = await started({ users: [], files: {} });
    await writeFile(join(storage.root, "probe.txt"), "ok");
    expect(await readFile(join(storage.root, "probe.txt"), "utf8")).toBe("ok");
  });
});

describe("insertLocalUsers", () => {
  function recordingRepos() {
    const calls: string[] = [];
    const repos: LocalUserRepos = {
      localUsers: {
        create: async ({ username, passwordHash }) => {
          calls.push(`create ${username} ${passwordHash}`);
        },
        update: async (username, patch) => {
          calls.push(`update ${username} ${JSON.stringify(patch)}`);
        },
      },
      localGrants: {
        put: async ({ ownerUsername, path, granteeUsername, access }) => {
          calls.push(`grant ${ownerUsername}:${path} -> ${granteeUsername} ${access}`);
        },
      },
    };
    return { calls, repos };
  }
  const passwords = { hash: async (password: string) => `hashed(${password})` };

  it("creates every user with a hashed password before any grant", async () => {
    const { calls, repos } = recordingRepos();
    await insertLocalUsers(repos, { users: SEED_USERS, grants: SEED_GRANTS }, passwords);

    expect(calls).toEqual([
      "create alice hashed(alice-password)",
      "create bob hashed(bob-password)",
      "create carol hashed(carol-password)",
      "grant alice:/docs -> bob read",
      "grant bob:/inbox -> carol write",
    ]);
  });

  it("disables the users it is told to, and needs no grants", async () => {
    const { calls, repos } = recordingRepos();
    await insertLocalUsers(
      repos,
      { users: [{ username: "dave", password: "pw" }], disabled: ["dave", "nobody"] },
      passwords,
    );

    expect(calls).toEqual(["create dave hashed(pw)", 'update dave {"disabled":true}']);
  });
});
