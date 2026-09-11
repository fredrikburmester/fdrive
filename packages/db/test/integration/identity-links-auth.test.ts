import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CreateDbResult,
  createDb,
  createIdentityLinksRepo,
  createRepos,
  type IdentityLinksRepo,
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
const accountA = "00000000-0000-0000-0000-000000000011";
const accountB = "00000000-0000-0000-0000-000000000012";
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
let a: IdentityLinksRepo;
let b: IdentityLinksRepo;
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
    .values({ id: providerId, type: "sftpgo", baseUrl: "http://provider" });
  a = createIdentityLinksRepo(first.db);
  b = createIdentityLinksRepo(second.db);
});
afterAll(async () => {
  await Promise.allSettled([first?.close(), second?.close()]);
  await container?.stop();
});
beforeEach(async () => {
  await first.db.execute(sql`truncate app.accounts cascade`);
  await first.db.insert(accounts).values([
    { id: accountA, displayName: "Target" },
    { id: accountB, displayName: "Other" },
  ]);
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
    sql`select count(*)::integer as count from app.sessions s join app.identities i on i.id=s.active_identity_id where s.account_id<>i.account_id`,
  );
  expect(rows.rows[0]?.count).toBe(0);
}
async function linkedFixture() {
  const alice = await a.linkVerified({ ...base, accountId: accountA });
  const sibling = await a.linkVerified({ ...base, username: "sibling", accountId: accountA });
  const bob = await a.linkVerified({ ...base, username: "bob", accountId: accountB });
  await first.db.insert(sessions).values([
    {
      idHash: "a".repeat(64),
      accountId: accountA,
      activeIdentityId: alice.id,
      createdAt: at,
      expiresAt: expiry,
      lastSeenAt: at,
      userAgent: "Original",
      ip: "::1",
    },
    {
      idHash: "b".repeat(64),
      accountId: accountB,
      activeIdentityId: bob.id,
      createdAt: at,
      expiresAt: expiry,
      lastSeenAt: at,
    },
    {
      idHash: "e".repeat(64),
      accountId: accountA,
      activeIdentityId: alice.id,
      createdAt: at,
      expiresAt: at,
      lastSeenAt: at,
    },
  ]);
  const [tag] = await first.db
    .insert(tags)
    .values({ accountId: accountA, name: "Used", color: "red" })
    .returning();
  if (!tag) throw new Error("Missing tag");
  await first.db.insert(fileTags).values({ identityId: alice.id, path: "/file", tagId: tag.id });
  await first.db
    .insert(apiTokens)
    .values({ accountId: accountA, identityId: alice.id, name: "Token", tokenHash: "token" });
  return { alice, sibling, bob };
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
      activeIdentityId: result.identity.id,
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
    expect(await first.db.select().from(accounts)).toHaveLength(3);
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
    const f = await linkedFixture();
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
    // Account A (alice + sibling) keeps only the new session; account B and
    // the unrelated new user are untouched; the expired "e" row goes too.
    expect(remaining.map((s) => s.idHash)).toEqual(["1", "b", "c"].map((h) => h.repeat(64)));
    expect(remaining[0]).toMatchObject({
      accountId: f.alice.accountId,
      activeIdentityId: f.alice.id,
    });
    expect(replaced.session.idHash).toBe("1".repeat(64));
    expect(kept.session.accountId).toBe(f.alice.accountId);
    await assertSessionOwnership();
    await expect(
      a.loginVerified({
        ...loginInput("2"),
        revokeOtherSessions: "yes" as unknown as boolean,
      }),
    ).rejects.toThrow(TypeError);
  });
  it("serializes first logins across pools without duplicate accounts or identities", async () => {
    const logins = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 ? a : b).loginVerified(loginInput(index.toString(16))),
      ),
    );
    expect(new Set(logins.map((r) => r.identity.id)).size).toBe(1);
    expect(await first.db.select().from(accounts)).toHaveLength(3);
    expect(await first.db.select().from(identities)).toHaveLength(1);
    expect(await first.db.select().from(sessions)).toHaveLength(10);
    await assertSessionOwnership();
  });
  it("serializes a first login racing verified linking and leaves no foreign sessions", async () => {
    const [login, linked] = await Promise.all([
      a.loginVerified(loginInput("a")),
      b.linkVerified({ ...base, accountId: accountA }),
    ]);
    expect(login.identity.id).toBe(linked.id);
    const [identity] = await first.db.select().from(identities);
    expect(identity?.accountId).toBe(accountA);
    const allAccounts = await first.db.select().from(accounts);
    // A successful login account is retained if a subsequent transfer empties it.
    expect(allAccounts.length).toBe(login.identity.accountId === accountA ? 2 : 3);
    await assertSessionOwnership();
  });
  it("serializes login against transfer and unlink", async () => {
    const f = await linkedFixture();
    await Promise.all([
      a.loginVerified(loginInput("c")),
      b.linkVerified({ ...base, accountId: accountB }),
    ]);
    await assertSessionOwnership();
    const afterTransfer = await a.loginVerified(loginInput("d"));
    expect(afterTransfer.identity.accountId).toBe(accountB);
    await Promise.all([
      a.loginVerified(loginInput("f")),
      b.unlink({ accountId: accountB, identityId: f.alice.id, at }),
    ]);
    await assertSessionOwnership();
    const [identity] = await first.db
      .select()
      .from(identities)
      .where(eq(identities.id, f.alice.id));
    const afterUnlink = await a.loginVerified(loginInput("1"));
    expect(afterUnlink.identity.accountId).toBe(identity?.accountId);
  });
  it("rolls back accounts, credentials, login timestamps and sessions on sealing or insertion failure", async () => {
    const before = await snapshot();
    await expect(
      a.loginVerified({
        ...loginInput("a"),
        sealCredential: () => {
          throw new Error("seal failed");
        },
      }),
    ).rejects.toThrow("seal failed");
    expect(await snapshot()).toEqual(before);
    await a.loginVerified(loginInput("a"));
    const existing = await snapshot();
    await expect(
      a.loginVerified({
        ...loginInput("b"),
        at: later,
        sealCredential: () => {
          throw new Error("seal failed");
        },
      }),
    ).rejects.toThrow("seal failed");
    expect(await snapshot()).toEqual(existing);
    await expect(a.loginVerified({ ...loginInput("a"), at: later })).rejects.toThrow();
    expect(await snapshot()).toEqual(existing);
  });
});

describe("requesting session authorization", () => {
  it("rejects absent, expired and foreign requesting sessions before link or unlink changes", async () => {
    const f = await linkedFixture();
    const before = await snapshot();
    for (const hash of ["b", "e", "f"]) {
      await expect(
        a.linkVerified({
          ...base,
          username: "bob",
          accountId: accountA,
          requestingSessionIdHash: hash.repeat(64),
        }),
      ).rejects.toMatchObject({ code: "invalid_session" });
      await expect(
        a.unlink({
          accountId: accountA,
          identityId: f.alice.id,
          at,
          requestingSessionIdHash: hash.repeat(64),
        }),
      ).rejects.toMatchObject({ code: "invalid_session" });
      expect(await snapshot()).toEqual(before);
    }
  });
  it("accepts live requesting sessions and rejects one revoked by logout", async () => {
    const f = await linkedFixture();
    await a.linkVerified({
      ...base,
      username: "new",
      accountId: accountA,
      requestingSessionIdHash: "a".repeat(64),
    });
    await a.unlink({
      accountId: accountA,
      identityId: f.sibling.id,
      at,
      requestingSessionIdHash: "a".repeat(64),
    });
    await createRepos(second.db).sessions.delete("a".repeat(64));
    const before = await snapshot();
    await expect(
      a.linkVerified({
        ...base,
        username: "another",
        accountId: accountA,
        requestingSessionIdHash: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "invalid_session" });
    expect(await snapshot()).toEqual(before);
  });
  it("rechecks a requesting session when logout races link or unlink", async () => {
    const f = await linkedFixture();
    const result = await Promise.allSettled([
      a.linkVerified({
        ...base,
        username: "new",
        accountId: accountA,
        requestingSessionIdHash: "a".repeat(64),
      }),
      createRepos(second.db).sessions.delete("a".repeat(64)),
    ]);
    if (result[0]?.status === "rejected")
      expect(result[0].reason).toMatchObject({ code: "invalid_session" });
    expect(await createRepos(first.db).sessions.getByIdHash("a".repeat(64), at)).toBeNull();
    await expect(
      a.unlink({
        accountId: accountA,
        identityId: f.alice.id,
        at,
        requestingSessionIdHash: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "invalid_session" });
    await assertSessionOwnership();
  });
});

describe("atomic session rotation", () => {
  it("preserves expiry and metadata, revokes the old hash and changes only this session", async () => {
    const f = await linkedFixture();
    const before = await snapshot();
    const rotated = await a.rotateSession({
      accountId: accountA,
      oldSessionIdHash: "a".repeat(64),
      newSessionIdHash: "c".repeat(64),
      activeIdentityId: f.sibling.id,
      at: later,
    });
    expect(rotated).toMatchObject({
      accountId: accountA,
      activeIdentityId: f.sibling.id,
      // Rotation keeps the original login time: it must not extend the
      // session's absolute lifetime.
      createdAt: at,
      lastSeenAt: later,
      expiresAt: expiry,
      userAgent: "Original",
      ip: "::1",
    });
    expect(await createRepos(first.db).sessions.getByIdHash("a".repeat(64), at)).toBeNull();
    const after = await snapshot();
    expect(after.sessions.filter((s) => s.idHash !== rotated.idHash)).toEqual(
      before.sessions.filter((s) => s.idHash !== "a".repeat(64)),
    );
    expect(after.credentials).toEqual(before.credentials);
  });
  it("rolls back duplicate hashes and rejects expired, foreign, revoked sessions or identities", async () => {
    const f = await linkedFixture();
    const request = {
      accountId: accountA,
      oldSessionIdHash: "a".repeat(64),
      newSessionIdHash: "c".repeat(64),
      activeIdentityId: f.alice.id,
      at,
    };
    const before = await snapshot();
    await expect(
      a.rotateSession({ ...request, newSessionIdHash: "b".repeat(64) }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    for (const hash of ["b", "e", "f"])
      await expect(
        a.rotateSession({ ...request, oldSessionIdHash: hash.repeat(64) }),
      ).rejects.toMatchObject({ code: "invalid_session" });
    await expect(a.rotateSession({ ...request, activeIdentityId: f.bob.id })).rejects.toMatchObject(
      { code: "forbidden" },
    );
    expect(await snapshot()).toEqual(before);
  });
  it("allows only one competing rotation and serializes with logout and transfer", async () => {
    const f = await linkedFixture();
    const request = {
      accountId: accountA,
      oldSessionIdHash: "a".repeat(64),
      newSessionIdHash: "c".repeat(64),
      activeIdentityId: f.alice.id,
      at,
    };
    const results = await Promise.allSettled([
      a.rotateSession(request),
      b.rotateSession({ ...request, newSessionIdHash: "d".repeat(64) }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "invalid_session" },
    });
    const winner = results.find((r) => r.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("Missing rotation");
    await Promise.allSettled([
      a.rotateSession({
        ...request,
        oldSessionIdHash: winner.value.idHash,
        newSessionIdHash: "f".repeat(64),
      }),
      createRepos(second.db).sessions.delete(winner.value.idHash),
    ]);
    await assertSessionOwnership();
    const login = await a.loginVerified(loginInput("1"));
    const transferRace = await Promise.allSettled([
      a.rotateSession({
        ...request,
        oldSessionIdHash: login.session.idHash,
        newSessionIdHash: "2".repeat(64),
      }),
      b.linkVerified({ ...base, accountId: accountB }),
    ]);
    expect(transferRace[1]?.status).toBe("fulfilled");
    await assertSessionOwnership();
    const oldAccountSessions = await first.db
      .select()
      .from(sessions)
      .where(eq(sessions.accountId, accountA));
    expect(oldAccountSessions.every((s) => s.activeIdentityId !== f.alice.id)).toBe(true);
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
  const repo = createIdentityLinksRepo(closed.db);
  await expect(repo.loginVerified({ ...loginInput("a"), username: "" })).rejects.toThrow(TypeError);
  await expect(
    repo.rotateSession({
      accountId: accountA,
      activeIdentityId: missing,
      oldSessionIdHash: "bad",
      newSessionIdHash: "a".repeat(64),
      at,
    }),
  ).rejects.toThrow(TypeError);
  await expect(createRepos(closed.db).providers.get("bad")).rejects.toThrow(TypeError);
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
  const row = await repos.providers.create({ type: "sftpgo", baseUrl: "http://delete-race" });
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
