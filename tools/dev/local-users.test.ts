import { ConflictError, type Repos, SETUP_OWNER_KEY } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import { createScryptSharePasswords } from "../../apps/api/src/shares/passwords.ts";
import { recordOwner, seedLocalUsers } from "./local-users.js";

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
    const [row] = await repos.providers.list();
    expect(row).toMatchObject({ type: "local", baseUrl: "local" });
    expect(await repos.identities.findByProviderUsername(row?.id ?? "", "dev")).not.toBeNull();
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
    const racing: Pick<Repos, "localUsers" | "logins" | "providers"> = {
      ...repos,
      logins: {
        ...repos.logins,
        createUser: async () => {
          throw new ConflictError("username already exists");
        },
      },
    };
    expect(await seedLocalUsers(racing, users, { hash: async () => "h" })).toEqual([]);
    const broken: Pick<Repos, "localUsers" | "logins" | "providers"> = {
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

describe("recordOwner", () => {
  it("records the user as the owner once, as setup does", async () => {
    const repos = createMemoryRepos();
    await seedLocalUsers(repos, users, { hash: async () => "h" });
    await recordOwner(repos, "dev");
    const [row] = await repos.providers.list();
    const dev = await repos.identities.findByProviderUsername(row?.id ?? "", "dev");
    expect(await repos.settings.get(SETUP_OWNER_KEY)).toEqual({
      state: "complete",
      accountId: dev?.accountId,
    });
    // An owner already recorded stays.
    await recordOwner(repos, "alice");
    expect(await repos.settings.get(SETUP_OWNER_KEY)).toMatchObject({ accountId: dev?.accountId });
  });

  it("refuses a user without a login", async () => {
    await expect(recordOwner(createMemoryRepos(), "nobody")).rejects.toThrow("has no login");
  });
});
