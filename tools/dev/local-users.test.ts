import { ConflictError, type Repos } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import { createScryptSharePasswords } from "../../apps/api/src/shares/passwords.ts";
import { seedLocalUsers } from "./local-users.js";

const users = [
  { username: "alice", password: "alice-password" },
  { username: "dev", password: "dev" },
];

describe("seedLocalUsers", () => {
  it("creates each user, with their login, and a hash the api accepts at sign-in", async () => {
    const repos = createMemoryRepos();
    expect(await seedLocalUsers(repos, users)).toEqual(["alice", "dev"]);
    const passwords = createScryptSharePasswords();
    const dev = await repos.localUsers.get("dev");
    expect(dev?.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await passwords.verify("dev", dev?.passwordHash ?? null)).toBe(true);
    expect(await passwords.verify("alice-password", dev?.passwordHash ?? null)).toBe(false);
    expect(dev?.disabled).toBe(false);
    expect(await repos.identities.findByUsername("dev")).not.toBeNull();
  });

  it("makes the users marked as administrators ones, also when they exist", async () => {
    const repos = createMemoryRepos();
    const isAdmin = async (username: string) => {
      const login = await repos.identities.findByUsername(username);
      return (await repos.accounts.get(login?.accountId ?? ""))?.isAdmin;
    };
    await seedLocalUsers(repos, [{ username: "dev", password: "dev" }], { hash: async () => "h" });
    expect(await isAdmin("dev")).toBe(false);
    const marked = [...users.slice(0, 1), { username: "dev", password: "dev", isAdmin: true }];
    expect(await seedLocalUsers(repos, marked, { hash: async () => "h" })).toEqual(["alice"]);
    expect(await isAdmin("dev")).toBe(true);
    expect(await isAdmin("alice")).toBe(false);
    const fresh = createMemoryRepos();
    await seedLocalUsers(fresh, [{ username: "perf", password: "p", isAdmin: true }], {
      hash: async () => "h",
    });
    const login = await fresh.identities.findByUsername("perf");
    expect((await fresh.accounts.get(login?.accountId ?? ""))?.isAdmin).toBe(true);
  });

  it("leaves a user that already exists alone", async () => {
    const repos = createMemoryRepos();
    await seedLocalUsers(repos, [{ username: "Alice", password: "kept" }], {
      hash: async () => "kept",
    });
    expect(await seedLocalUsers(repos, users, { hash: async () => "new" })).toEqual(["dev"]);
    expect((await repos.localUsers.get("alice"))?.passwordHash).toBe("kept");
    expect(await seedLocalUsers(repos, users, { hash: async () => "new" })).toEqual([]);
  });

  it("treats a user created concurrently as present, and rethrows anything else", async () => {
    const repos = createMemoryRepos();
    const racing: Pick<Repos, "localUsers" | "logins"> = {
      ...repos,
      logins: {
        ...repos.logins,
        createUser: async () => {
          throw new ConflictError("username already exists");
        },
      },
    };
    expect(await seedLocalUsers(racing, users, { hash: async () => "h" })).toEqual([]);
    const broken: Pick<Repos, "localUsers" | "logins"> = {
      ...repos,
      logins: {
        ...repos.logins,
        createUser: async () => {
          throw new Error("database is down");
        },
      },
    };
    await expect(seedLocalUsers(broken, users, { hash: async () => "h" })).rejects.toThrow(
      "database is down",
    );
  });
});
