import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  type CreateDbResult,
  createDb,
  createRepos,
  type LoginRepo,
  migrate,
  SETUP_OWNER_KEY,
} from "../../src/index.js";
import {
  accounts,
  apiTokens,
  identities,
  localUsers,
  providers,
  sessions,
  settings,
} from "../../src/schema/app.js";

const providerId = "00000000-0000-0000-0000-000000000001";
const at = new Date("2026-09-07T01:00:00Z");
const later = new Date(at.getTime() + 1000);
const expiry = new Date(at.getTime() + 60000);
const user = (username: string) => ({
  providerId,
  username,
  passwordHash: "scrypt$h",
  isAdmin: false,
  at,
});
const session = (hash: string) => ({
  idHash: hash.repeat(64),
  expiresAt: expiry,
  userAgent: "Agent/1",
  ip: "127.0.0.1",
});
let container: StartedPostgreSqlContainer | undefined;
let first: CreateDbResult;
let second: CreateDbResult;
let a: LoginRepo;
let b: LoginRepo;
beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withDatabase("fdrive_test")
    .withUsername("fdrive")
    .withPassword("fdrive")
    .start();
  first = createDb(container.getConnectionUri());
  second = createDb(container.getConnectionUri());
  await migrate(first.db);
  await first.db.insert(providers).values({ id: providerId, type: "local", baseUrl: "local" });
  a = createRepos(first.db).logins;
  b = createRepos(second.db).logins;
});
afterAll(async () => {
  await Promise.allSettled([first?.close(), second?.close()]);
  await container?.stop();
});
beforeEach(async () => {
  await first.db.execute(sql`truncate app.accounts, app.local_users, app.settings cascade`);
});
async function snapshot() {
  return {
    users: await first.db.select().from(localUsers).orderBy(asc(localUsers.username)),
    accounts: await first.db.select().from(accounts).orderBy(asc(accounts.id)),
    identities: await first.db.select().from(identities).orderBy(asc(identities.id)),
    sessions: await first.db.select().from(sessions).orderBy(asc(sessions.idHash)),
    settings: await first.db.select().from(settings).orderBy(asc(settings.key)),
  };
}

describe("creating users", () => {
  it("writes the user, the account and the login with the caller's time", async () => {
    const identity = await a.createUser({ ...user("alice"), isAdmin: true });

    expect(identity).toMatchObject({ externalUsername: "alice", providerId, createdAt: at });
    const [account] = await first.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, identity.accountId));
    expect(account).toMatchObject({ displayName: "alice", isAdmin: true, createdAt: at });
    const [row] = await first.db.select().from(localUsers);
    expect(row).toMatchObject({ username: "alice", createdAt: at, updatedAt: at });
  });

  it("lets one of two racing pools create a name, whatever its case, and leaves nothing of the other", async () => {
    const results = await Promise.allSettled([
      a.createUser(user("bob")),
      b.createUser(user("BOB")),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(ConflictError),
    });
    const after = await snapshot();
    expect(after.users).toHaveLength(1);
    expect(after.accounts).toHaveLength(1);
    expect(after.identities).toHaveLength(1);
  });

  it("refuses a login a removed user left under another spelling, in the database itself", async () => {
    await a.createUser(user("carol"));
    await first.db.delete(localUsers).where(eq(localUsers.username, "carol"));
    const before = await snapshot();

    await expect(a.createUser(user("Carol"))).rejects.toBeInstanceOf(ConflictError);

    expect(await snapshot()).toEqual(before);
  });

  it("validates before any IO", async () => {
    const closed = createDb("postgresql://unused:unused@127.0.0.1:1/unused");
    await closed.close();
    const repos = createRepos(closed.db);
    await expect(repos.logins.createUser(user(""))).rejects.toThrow(TypeError);
    await expect(
      repos.logins.signIn({ username: "x", at, session: { ...session("a"), expiresAt: at } }),
    ).rejects.toThrow(TypeError);
  });
});

describe("setup", () => {
  it("refuses a database that has users, though it has no owner record", async () => {
    await a.createUser(user("frank"));
    const before = await snapshot();

    await expect(a.setup(user("mallory"))).rejects.toMatchObject({ code: "setup_claimed" });

    expect(await snapshot()).toEqual(before);
  });

  it("serializes setup with a user created at the same time: setup wins only if it went first", async () => {
    const [setup, added] = await Promise.allSettled([
      a.setup(user("gail")),
      b.createUser(user("hank")),
    ]);

    expect(added.status).toBe("fulfilled");
    const after = await snapshot();
    if (setup.status === "fulfilled") {
      expect(after.users.map((row) => row.username)).toEqual(["gail", "hank"]);
    } else {
      expect(setup.reason).toMatchObject({ code: "setup_claimed" });
      expect(after.users.map((row) => row.username)).toEqual(["hank"]);
      expect(after.settings).toEqual([]);
    }
  });

  it("never overwrites an owner record, even on an otherwise empty database", async () => {
    await first.db
      .insert(settings)
      .values({ key: SETUP_OWNER_KEY, value: { state: "complete", accountId: "earlier" } });
    const before = await snapshot();

    await expect(a.setup(user("ivan"))).rejects.toMatchObject({ code: "setup_claimed" });

    expect(await snapshot()).toEqual(before);
  });
  it("lets exactly one of two racing pools own the installation, and rolls the other back", async () => {
    const results = await Promise.allSettled([a.setup(user("dave")), b.setup(user("erin"))]);

    const won = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    expect(won).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "setup_claimed" },
    });
    const after = await snapshot();
    expect(after.users.map((row) => row.username)).toEqual([won[0]?.externalUsername]);
    expect(after.accounts).toEqual([expect.objectContaining({ isAdmin: true })]);
    expect(after.identities).toHaveLength(1);
    expect(after.settings).toEqual([
      expect.objectContaining({
        key: SETUP_OWNER_KEY,
        value: { state: "complete", accountId: won[0]?.accountId },
      }),
    ]);
  });
});

describe("administrators", () => {
  it("lets only one of two racing pools remove the last two administrators", async () => {
    await a.createUser({ ...user("jo"), isAdmin: true });
    await a.createUser({ ...user("kai"), isAdmin: true });

    const results = await Promise.allSettled([a.removeUser("jo"), b.removeUser("kai")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "last_admin" },
    });
    expect((await snapshot()).users).toHaveLength(1);
  });

  it("lets only one of two racing pools disable and demote the last two administrators", async () => {
    await a.createUser({ ...user("lee"), isAdmin: true });
    await a.createUser({ ...user("max"), isAdmin: true });

    const results = await Promise.allSettled([
      a.updateUser("lee", { disabled: true, at }),
      b.updateUser("max", { isAdmin: false, at }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
});

describe("signing in", () => {
  it("finds the login in any case and keeps every other session", async () => {
    const alice = await a.createUser(user("Alice"));
    await a.signIn({ username: "alice", at, session: session("a") });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        (index % 2 ? a : b).signIn({
          username: index % 2 ? "ALICE" : "Alice",
          at: later,
          session: session(index.toString(16).replace("0", "b")),
        }),
      ),
    );

    expect(new Set(results.map((result) => result.identity.id))).toEqual(new Set([alice.id]));
    const rows = await first.db.select().from(sessions);
    expect(rows).toHaveLength(7);
    expect(
      rows.every((row) => row.identityId === alice.id && row.accountId === alice.accountId),
    ).toBe(true);
    const [login] = await first.db.select().from(identities);
    expect(login?.lastLoginAt).toEqual(later);
  });

  it("writes nothing for a name without a login", async () => {
    await a.createUser(user("frank"));
    const before = await snapshot();

    await expect(a.signIn({ username: "gina", at, session: session("c") })).rejects.toMatchObject({
      code: "missing_identity",
    });

    expect(await snapshot()).toEqual(before);
  });

  it("ends a login's sessions and tokens with it", async () => {
    const hank = await a.createUser(user("hank"));
    const ivy = await a.createUser(user("ivy"));
    await a.signIn({ username: "hank", at, session: session("d") });
    await a.signIn({ username: "ivy", at, session: session("e") });
    await first.db.insert(apiTokens).values({
      accountId: hank.accountId,
      identityId: hank.id,
      name: "Token",
      tokenHash: "token",
    });

    await first.db.delete(identities).where(eq(identities.id, hank.id));

    expect((await first.db.select().from(sessions)).map((row) => row.identityId)).toEqual([ivy.id]);
    expect(await first.db.select().from(apiTokens)).toEqual([]);
  });
});
