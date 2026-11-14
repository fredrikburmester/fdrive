import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CreateDbResult,
  createDb,
  createLoginRepo,
  createRepos,
  type LoginRepo,
  type LoginVerifiedInput,
  migrate,
} from "../../src/index.js";
import {
  accounts,
  apiTokens,
  credentials,
  fileTags,
  identities,
  providers,
  sessions,
  tags,
} from "../../src/schema/app.js";

const providerId = "00000000-0000-0000-0000-000000000001";
const missing = "00000000-0000-0000-0000-000000000099";
const at = new Date("2026-09-07T01:00:00Z");
const later = new Date(at.getTime() + 1000);
const expiry = new Date(at.getTime() + 60000);
const sealCredential = () => ({ ciphertext: new Uint8Array([1, 2]), keyId: "test" });
const base = { providerId, username: "alice", at, sealCredential };
function loginInput(hash: string, username = "alice"): LoginVerifiedInput {
  return {
    ...base,
    username,
    session: { idHash: hash.repeat(64), expiresAt: expiry, userAgent: "Agent/1", ip: "127.0.0.1" },
  };
}
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
  await first.db
    .insert(providers)
    .values({ id: providerId, type: "local", baseUrl: "http://provider" });
  a = createLoginRepo(first.db);
  b = createLoginRepo(second.db);
});
afterAll(async () => {
  await Promise.allSettled([first?.close(), second?.close()]);
  await container?.stop();
});
beforeEach(async () => {
  await first.db.execute(sql`truncate app.accounts cascade`);
});
async function snapshot() {
  return {
    accounts: await first.db.select().from(accounts).orderBy(asc(accounts.id)),
    identities: await first.db.select().from(identities).orderBy(asc(identities.id)),
    credentials: await first.db.select().from(credentials).orderBy(asc(credentials.identityId)),
    sessions: await first.db.select().from(sessions).orderBy(asc(sessions.idHash)),
    tags: await first.db.select().from(tags).orderBy(asc(tags.id)),
    fileTags: await first.db
      .select()
      .from(fileTags)
      .orderBy(asc(fileTags.identityId), asc(fileTags.path), asc(fileTags.tagId)),
    tokens: await first.db.select().from(apiTokens).orderBy(asc(apiTokens.id)),
  };
}
async function assertSessionOwnership(): Promise<void> {
  const rows = await first.db.execute<{ count: number }>(
    sql`select count(*)::integer as count from app.sessions s join app.identities i on i.id=s.identity_id where s.account_id<>i.account_id`,
  );
  expect(rows.rows[0]?.count).toBe(0);
}
/** Two signed-in users, with a tag, a token and an expired session on alice's account. */
async function signedInFixture() {
  const alice = (await a.loginVerified(loginInput("a"))).identity;
  const bob = (await a.loginVerified(loginInput("b", "bob"))).identity;
  await first.db.insert(sessions).values({
    idHash: "e".repeat(64),
    accountId: alice.accountId,
    identityId: alice.id,
    createdAt: at,
    expiresAt: at,
    lastSeenAt: at,
  });
  const [tag] = await first.db
    .insert(tags)
    .values({ accountId: alice.accountId, name: "Used", color: "red" })
    .returning();
  if (!tag) throw new Error("Missing tag");
  await first.db.insert(fileTags).values({ identityId: alice.id, path: "/file", tagId: tag.id });
  await first.db.insert(apiTokens).values({
    accountId: alice.accountId,
    identityId: alice.id,
    name: "Token",
    tokenHash: "token",
  });
  return { alice, bob };
}

describe("atomic verified login", () => {
  it("creates a nonadmin account, correct credential AAD and owned session together", async () => {
    let sealedId = "";
    const result = await a.loginVerified({
      ...loginInput("a"),
      sealCredential: (id) => {
        sealedId = id;
        return sealCredential();
      },
    });
    expect(sealedId).toBe(result.identity.id);
    expect(result.session).toMatchObject({
      idHash: "a".repeat(64),
      accountId: result.identity.accountId,
      identityId: result.identity.id,
      createdAt: at,
      lastSeenAt: at,
      expiresAt: expiry,
      userAgent: "Agent/1",
      ip: "127.0.0.1",
    });
    const [account] = await first.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, result.identity.accountId));
    expect(account).toMatchObject({ displayName: "alice", isAdmin: false, createdAt: at });
    const [credential] = await first.db.select().from(credentials);
    expect(credential).toMatchObject({
      identityId: result.identity.id,
      ciphertext: Buffer.from([1, 2]),
      cachedToken: null,
    });
  });
  it("refreshes existing credentials and creates sessions without extra accounts", async () => {
    const firstLogin = await a.loginVerified(loginInput("a"));
    await first.db
      .update(credentials)
      .set({ cachedToken: "stale", cachedTokenExpiresAt: expiry })
      .where(eq(credentials.identityId, firstLogin.identity.id));
    const next = await b.loginVerified({ ...loginInput("b"), at: later });
    expect(next.identity).toEqual({ ...firstLogin.identity, lastLoginAt: later });
    expect(await first.db.select().from(accounts)).toHaveLength(1);
    expect(await first.db.select().from(sessions)).toHaveLength(2);
    const [credential] = await first.db.select().from(credentials);
    expect(credential).toMatchObject({
      cachedToken: null,
      cachedTokenExpiresAt: null,
      updatedAt: later,
    });
    await assertSessionOwnership();
  });
  it("revokes every other session of the account only when asked, and never on a first login", async () => {
    const f = await signedInFixture();
    await a.loginVerified({ ...loginInput("c", "new-user"), revokeOtherSessions: true });
    expect(await first.db.select().from(sessions)).toHaveLength(4);
    const kept = await a.loginVerified({ ...loginInput("d"), at: later });
    expect((await first.db.select().from(sessions)).map((s) => s.idHash).sort()).toEqual(
      ["a", "b", "c", "d", "e"].map((h) => h.repeat(64)),
    );
    const replaced = await a.loginVerified({
      ...loginInput("1"),
      at: later,
      revokeOtherSessions: true,
    });
    const remaining = await first.db.select().from(sessions).orderBy(asc(sessions.idHash));
    // Alice keeps only the new session; bob and the unrelated new user are
    // untouched; the expired "e" row goes too.
    expect(remaining.map((s) => s.idHash)).toEqual(["1", "b", "c"].map((h) => h.repeat(64)));
    expect(remaining[0]).toMatchObject({ accountId: f.alice.accountId, identityId: f.alice.id });
    expect(replaced.session.idHash).toBe("1".repeat(64));
    expect(kept.session.accountId).toBe(f.alice.accountId);
    await assertSessionOwnership();
  });
  it("serializes first logins across pools without duplicate accounts or identities", async () => {
    const logins = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 ? a : b).loginVerified(loginInput(index.toString(16))),
      ),
    );
    expect(new Set(logins.map((r) => r.identity.id)).size).toBe(1);
    expect(await first.db.select().from(accounts)).toHaveLength(1);
    expect(await first.db.select().from(identities)).toHaveLength(1);
    expect(await first.db.select().from(sessions)).toHaveLength(10);
    await assertSessionOwnership();
  });
  it("rolls back accounts, credentials, login timestamps and sessions on sealing or insertion failure", async () => {
    await signedInFixture();
    const before = await snapshot();
    await expect(
      a.loginVerified({
        ...loginInput("c", "carol"),
        sealCredential: () => {
          throw new Error("seal failed");
        },
      }),
    ).rejects.toThrow("seal failed");
    expect(await snapshot()).toEqual(before);
    await expect(
      a.loginVerified({
        ...loginInput("c"),
        at: later,
        sealCredential: () => {
          throw new Error("seal failed");
        },
      }),
    ).rejects.toThrow("seal failed");
    expect(await snapshot()).toEqual(before);
    await expect(a.loginVerified({ ...loginInput("a"), at: later })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});

it("validates before IO and reports missing provider without a speculative account", async () => {
  const before = await snapshot();
  await expect(a.loginVerified({ ...loginInput("a"), providerId: missing })).rejects.toMatchObject({
    code: "missing_provider",
  });
  expect(await snapshot()).toEqual(before);
  const closed = createDb("postgresql://unused:unused@127.0.0.1:1/unused");
  await closed.close();
  const repo = createLoginRepo(closed.db);
  await expect(repo.loginVerified({ ...loginInput("a"), username: "" })).rejects.toThrow(TypeError);
  await expect(createRepos(closed.db).providers.get("bad")).rejects.toThrow(TypeError);
});

it("refuses a second login for an account in the database itself", async () => {
  const alice = (await a.loginVerified(loginInput("a"))).identity;
  await expect(
    first.db
      .insert(identities)
      .values({ accountId: alice.accountId, providerId, externalUsername: "second" }),
  ).rejects.toThrow();
  expect(await first.db.select().from(identities)).toHaveLength(1);
});

it("ends a login's sessions and tokens with it", async () => {
  const { alice, bob } = await signedInFixture();
  await first.db.delete(identities).where(eq(identities.id, alice.id));
  expect((await first.db.select().from(sessions)).map((s) => s.identityId)).toEqual([bob.id]);
  expect(await first.db.select().from(apiTokens)).toEqual([]);
});

it("compares credentials under the login lock so equal replacements retain both sessions", async () => {
  await a.loginVerified(loginInput("a"));
  const observed: number[] = [];
  const replace = (hash: string): LoginVerifiedInput => ({
    ...loginInput(hash),
    compareCredential: (_id, current) => {
      observed.push(current?.ciphertext[0] ?? 0);
      return current?.ciphertext[0] !== 9;
    },
    sealCredential: () => ({ ciphertext: new Uint8Array([9]), keyId: "test" }),
  });
  await Promise.all([a.loginVerified(replace("b")), b.loginVerified(replace("c"))]);
  expect(observed).toEqual([1, 9]);
  const remaining = await first.db.select().from(sessions);
  expect(remaining.map((row) => row.idHash).sort()).toEqual(["b".repeat(64), "c".repeat(64)]);
});

it("serializes provider deletion with first login without raw database failures", async () => {
  const repos = createRepos(second.db);
  const row = await repos.providers.create({ type: "local", baseUrl: "http://delete-race" });
  const [login, removal] = await Promise.allSettled([
    a.loginVerified({ ...loginInput("d"), providerId: row.id }),
    repos.providers.delete(row.id),
  ]);
  expect([login, removal].filter((result) => result.status === "fulfilled")).toHaveLength(1);
  if (login.status === "fulfilled") {
    expect(removal).toMatchObject({ reason: { name: "ConflictError" } });
    expect(await repos.providers.get(row.id)).not.toBeNull();
  } else {
    expect(login.reason).toMatchObject({ code: "missing_provider" });
    expect(await repos.identities.countByProvider(row.id)).toBe(0);
  }
});

it("rolls back every new auth record for a losing setup claimant", async () => {
  const repos = createRepos(second.db);
  const other = await repos.providers.create({ type: "local", baseUrl: "http://other-setup" });
  const key = "test.setup.race";
  const existingAccounts = await first.db.select().from(accounts);
  const results = await Promise.allSettled([
    a.loginVerified({ ...loginInput("a"), setupClaim: { key, baseUrl: "http://provider" } }),
    b.loginVerified({
      ...loginInput("b", "bob"),
      providerId: other.id,
      setupClaim: { key, baseUrl: other.baseUrl },
    }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "setup_claimed" },
  });
  expect(await first.db.select().from(accounts)).toHaveLength(existingAccounts.length + 1);
  expect(await first.db.select().from(identities)).toHaveLength(1);
  expect(await first.db.select().from(credentials)).toHaveLength(1);
  expect(await first.db.select().from(sessions)).toHaveLength(1);
});

it("preserves existing records when setup loses and allows only the pending owner to resume", async () => {
  const repos = createRepos(second.db);
  const existing = await b.loginVerified(loginInput("b", "bob"));
  const originalCredential = await repos.credentials.get(existing.identity.id);
  const key = "test.setup.existing";
  const setupClaim = { key, baseUrl: "http://provider" };
  const winner = await a.loginVerified({ ...loginInput("a"), setupClaim });
  await expect(
    b.loginVerified({
      ...loginInput("c", "bob"),
      setupClaim,
      revokeOtherSessions: true,
      sealCredential: () => ({ ciphertext: new Uint8Array([9]), keyId: "new" }),
    }),
  ).rejects.toMatchObject({ code: "setup_claimed" });
  expect(await repos.credentials.get(existing.identity.id)).toEqual(originalCredential);
  expect(await repos.sessions.getByIdHash(existing.session.idHash, at)).toEqual(existing.session);
  expect(await repos.identities.get(existing.identity.id)).toEqual(existing.identity);
  const resumed = await a.loginVerified({ ...loginInput("d"), setupClaim });
  expect(resumed.identity.accountId).toBe(winner.identity.accountId);
  await repos.settings.set(key, {
    version: 1,
    state: "complete",
    accountId: winner.identity.accountId,
    baseUrl: setupClaim.baseUrl,
  });
  await expect(a.loginVerified({ ...loginInput("e"), setupClaim })).rejects.toMatchObject({
    code: "setup_claimed",
  });
  expect(await first.db.select().from(sessions)).toHaveLength(3);
});

describe("provider endpoint binding", () => {
  it("rejects a login verified against an endpoint that changed before persistence", async () => {
    const repos = createRepos(first.db);
    const row = await repos.providers.ensure({ type: "local", baseUrl: "http://stale-login" });
    await repos.providers.update(row.id, { baseUrl: "http://replacement-login" });
    await expect(
      a.loginVerified({
        ...loginInput("e"),
        providerId: row.id,
        verifiedProvider: { type: row.type, baseUrl: row.baseUrl },
      }),
    ).rejects.toMatchObject({ code: "invalid_session" });
    expect(await repos.identities.countByProvider(row.id)).toBe(0);
  });

  it("serializes a racing address update and first login", async () => {
    const repos = createRepos(second.db);
    const row = await repos.providers.ensure({ type: "local", baseUrl: "http://race-login" });
    const [identityResult, addressResult] = await Promise.allSettled([
      a.loginVerified({
        ...loginInput("e"),
        providerId: row.id,
        verifiedProvider: { type: row.type, baseUrl: row.baseUrl },
      }),
      repos.providers.update(row.id, { baseUrl: "http://raced-login" }),
    ]);
    expect(
      [identityResult, addressResult].filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    if (identityResult.status === "fulfilled") {
      expect(await repos.providers.get(row.id)).toMatchObject({ baseUrl: row.baseUrl });
      expect(await repos.identities.countByProvider(row.id)).toBe(1);
    } else {
      expect(identityResult.reason).toMatchObject({ code: "invalid_session" });
      expect(await repos.identities.countByProvider(row.id)).toBe(0);
    }
  });
});
