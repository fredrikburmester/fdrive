import { ConflictError, type LocalUserRepo } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import { createScryptSharePasswords } from "../../apps/api/src/shares/passwords.ts";
import { seedLocalUsers } from "./local-users.js";

const users = [
  { username: "alice", password: "alice-password" },
  { username: "dev", password: "dev" },
];

describe("seedLocalUsers", () => {
  it("creates each user with a hash the api accepts at sign-in", async () => {
    const repo = createMemoryRepos().localUsers;
    expect(await seedLocalUsers(repo, users)).toEqual(["alice", "dev"]);
    const passwords = createScryptSharePasswords();
    const dev = await repo.get("dev");
    expect(dev?.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await passwords.verify("dev", dev?.passwordHash ?? null)).toBe(true);
    expect(await passwords.verify("alice-password", dev?.passwordHash ?? null)).toBe(false);
    expect(dev?.disabled).toBe(false);
  });

  it("leaves a user that already exists alone", async () => {
    const repo = createMemoryRepos().localUsers;
    await repo.create({ username: "Alice", passwordHash: "kept" });
    expect(await seedLocalUsers(repo, users, { hash: async () => "new" })).toEqual(["dev"]);
    expect((await repo.get("alice"))?.passwordHash).toBe("kept");
    expect(await seedLocalUsers(repo, users, { hash: async () => "new" })).toEqual([]);
  });

  it("treats a user created concurrently as present, and rethrows anything else", async () => {
    const racing: Pick<LocalUserRepo, "get" | "create"> = {
      get: async () => null,
      create: async () => {
        throw new ConflictError("username already exists");
      },
    };
    expect(await seedLocalUsers(racing, users, { hash: async () => "h" })).toEqual([]);
    const broken: Pick<LocalUserRepo, "get" | "create"> = {
      get: async () => null,
      create: async () => {
        throw new Error("database is down");
      },
    };
    await expect(seedLocalUsers(broken, users, { hash: async () => "h" })).rejects.toThrow(
      "database is down",
    );
  });
});
