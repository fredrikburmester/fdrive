import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CreateDbResult,
  createDb,
  createIdentityLinksRepo,
  createRepos,
  IdentityLinksError,
  type IdentityLinksRepo,
  migrate,
} from "../../src/index.js";
import {
  accounts,
  apiTokens,
  credentials,
  favorites,
  fileTags,
  identities,
  providers,
  recents,
  sessions,
  shares,
  tags,
} from "../../src/schema/app.js";

const providerId = "00000000-0000-0000-0000-000000000001";
const accountA = "00000000-0000-0000-0000-000000000011";
const accountB = "00000000-0000-0000-0000-000000000012";
const accountC = "00000000-0000-0000-0000-000000000013";
const missing = "00000000-0000-0000-0000-000000000099";
const at = new Date("2026-09-06T12:00:00Z");
const later = new Date(at.getTime() + 1000);
const expiry = new Date(at.getTime() + 60_000);
const sealed = { ciphertext: new Uint8Array([1, 2, 3]), keyId: "test-key" };
const base = {
  accountId: accountA,
  providerId,
  username: "alice",
  at,
  sealCredential: () => sealed,
};
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
    { id: accountA, displayName: "Source", isAdmin: true },
    { id: accountB, displayName: "Target" },
    { id: accountC, displayName: "Third" },
  ]);
});
async function makeSession(
  hash: string,
  accountId: string,
  identityId: string,
  expiresAt = expiry,
) {
  const [session] = await first.db
    .insert(sessions)
    .values({
      idHash: hash.repeat(64),
      accountId,
      activeIdentityId: identityId,
      expiresAt,
      createdAt: at,
      lastSeenAt: at,
    })
    .returning();
  if (!session) throw new Error("Missing session");
  return session;
}
async function fixture() {
  const alice = await a.linkVerified(base);
  const sibling = await a.linkVerified({ ...base, username: "sibling" });
  const target = await a.linkVerified({ ...base, accountId: accountB, username: "target" });
  await makeSession("a", accountA, alice.id);
  await makeSession("b", accountA, sibling.id);
  await makeSession("c", accountB, target.id);
  await first.db.insert(apiTokens).values([
    { accountId: accountA, identityId: alice.id, name: "alice", tokenHash: "alice" },
    { accountId: accountA, identityId: sibling.id, name: "sibling", tokenHash: "sibling" },
    { accountId: accountA, identityId: null, name: "account", tokenHash: "account" },
  ]);
  const inserted = await first.db
    .insert(tags)
    .values([
      { accountId: accountA, name: "Shared", color: "red" },
      { accountId: accountA, name: "Used", color: "green" },
      { accountId: accountA, name: "Unused", color: "yellow" },
      { accountId: accountB, name: "Shared", color: "blue" },
    ])
    .returning();
  const [shared, used, unused, targetShared] = inserted;
  if (!shared || !used || !unused || !targetShared) throw new Error("Missing tags");
  await first.db.insert(fileTags).values([
    { identityId: alice.id, path: "/file", tagId: shared.id },
    { identityId: alice.id, path: "/file", tagId: used.id },
    { identityId: sibling.id, path: "/other", tagId: shared.id },
  ]);
  await first.db.insert(favorites).values({ identityId: alice.id, path: "/file", createdAt: at });
  await first.db.insert(recents).values({ identityId: alice.id, path: "/file", openedAt: at });
  await first.db.insert(shares).values({
    identityId: alice.id,
    sftpgoShareId: "share",
    name: "Example",
    scope: "read",
    paths: ["/file"],
  });
  return { alice, sibling, target, shared, used, unused, targetShared };
}
async function snapshot() {
  return {
    accounts: await first.db.select().from(accounts).orderBy(asc(accounts.id)),
    identities: await first.db.select().from(identities).orderBy(asc(identities.id)),
    credentials: await first.db.select().from(credentials).orderBy(asc(credentials.identityId)),
    tags: await first.db.select().from(tags).orderBy(asc(tags.id)),
    fileTags: await first.db
      .select()
      .from(fileTags)
      .orderBy(asc(fileTags.identityId), asc(fileTags.path), asc(fileTags.tagId)),
    sessions: await first.db.select().from(sessions).orderBy(asc(sessions.idHash)),
    tokens: await first.db.select().from(apiTokens).orderBy(asc(apiTokens.id)),
    favorites: await first.db.select().from(favorites),
    recents: await first.db.select().from(recents),
    shares: await first.db.select().from(shares),
  };
}

describe("verified identity links", () => {
  it("creates identity in existing account, seals actual UUID and refreshes credentials idempotently", async () => {
    const observed: string[] = [];
    const alice = await a.linkVerified({
      ...base,
      sealCredential: (id) => {
        observed.push(id);
        return sealed;
      },
    });
    expect(observed).toEqual([alice.id]);
    expect(alice).toMatchObject({
      accountId: accountA,
      externalUsername: "alice",
      lastLoginAt: at,
    });
    await first.db
      .update(credentials)
      .set({ cachedToken: "stale", cachedTokenExpiresAt: expiry })
      .where(eq(credentials.identityId, alice.id));
    const refreshed = await b.linkVerified({
      ...base,
      at: later,
      sealCredential: () => ({ ciphertext: new Uint8Array([9]), keyId: "new" }),
    });
    expect(refreshed).toEqual({ ...alice, lastLoginAt: later });
    expect(await first.db.select().from(identities)).toHaveLength(1);
    expect(await first.db.select().from(accounts)).toHaveLength(3);
    const [credential] = await first.db.select().from(credentials);
    expect(credential).toMatchObject({
      identityId: alice.id,
      ciphertext: Buffer.from([9]),
      keyId: "new",
      cachedToken: null,
      cachedTokenExpiresAt: null,
      updatedAt: later,
    });
  });
  it("transfers only verified identity, preserves metadata, maps used tags and revokes scoped authority", async () => {
    const f = await fixture();
    const before = await snapshot();
    const linked = await b.linkVerified({ ...base, accountId: accountB, at: later });
    const after = await snapshot();
    expect(linked.id).toBe(f.alice.id);
    expect(linked.accountId).toBe(accountB);
    expect(after.accounts).toEqual(before.accounts);
    expect(after.identities.find((i) => i.id === f.sibling.id)).toEqual(f.sibling);
    expect(after.favorites).toEqual(before.favorites);
    expect(after.recents).toEqual(before.recents);
    expect(after.shares).toEqual(before.shares);
    expect(after.sessions).toEqual(
      before.sessions.filter((s) => s.activeIdentityId !== f.alice.id),
    );
    expect(after.tokens).toEqual(before.tokens.filter((t) => t.identityId !== f.alice.id));
    expect(after.tags.filter((t) => t.accountId === accountA)).toEqual(
      before.tags.filter((t) => t.accountId === accountA),
    );
    expect(
      after.tags
        .filter((t) => t.accountId === accountB)
        .map((t) => ({ name: t.name, color: t.color }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    ).toEqual([
      { name: "Shared", color: "blue" },
      { name: "Used", color: "green" },
    ]);
    expect(after.fileTags.filter((t) => t.identityId === f.sibling.id)).toEqual(
      before.fileTags.filter((t) => t.identityId === f.sibling.id),
    );
    const usedTarget = after.tags.find((t) => t.accountId === accountB && t.name === "Used");
    expect(
      after.fileTags
        .filter((t) => t.identityId === f.alice.id)
        .map((t) => t.tagId)
        .sort(),
    ).toEqual([f.targetShared.id, usedTarget?.id].sort());
  });
  it("rolls back creation and complete transfer when sealing fails", async () => {
    await expect(
      a.linkVerified({
        ...base,
        sealCredential: () => {
          throw new Error("seal failed");
        },
      }),
    ).rejects.toThrow("seal failed");
    expect(await first.db.select().from(identities)).toHaveLength(0);
    await fixture();
    const before = await snapshot();
    await expect(
      a.linkVerified({
        ...base,
        accountId: accountB,
        sealCredential: () => {
          throw new Error("seal failed");
        },
      }),
    ).rejects.toThrow("seal failed");
    expect(await snapshot()).toEqual(before);
    await expect(
      a.linkVerified({
        ...base,
        sealCredential: () => ({ ciphertext: new Uint8Array(), keyId: "key" }),
      }),
    ).rejects.toThrow(TypeError);
    expect(await snapshot()).toEqual(before);
  });
  it("serializes simultaneous creation and competing verified transfers from independent pools", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).linkVerified(base)),
    );
    expect(new Set(results.map((identity) => identity.id)).size).toBe(1);
    const moved = await Promise.all([
      a.linkVerified({ ...base, accountId: accountB }),
      b.linkVerified({ ...base, accountId: accountC }),
    ]);
    expect(moved[0]?.id).toBe(moved[1]?.id);
    expect(await first.db.select().from(identities)).toHaveLength(1);
    expect(await first.db.select().from(credentials)).toHaveLength(1);
    expect(await first.db.select().from(accounts)).toHaveLength(3);
  });
  it("moves opposing accounts without lock-order deadlocks", async () => {
    const alice = await a.linkVerified(base);
    const bob = await a.linkVerified({ ...base, accountId: accountB, username: "bob" });
    await Promise.all([
      a.linkVerified({ ...base, accountId: accountB }),
      b.linkVerified({ ...base, username: "bob" }),
    ]);
    const rows = await first.db.select().from(identities);
    expect(rows.find((i) => i.id === alice.id)?.accountId).toBe(accountB);
    expect(rows.find((i) => i.id === bob.id)?.accountId).toBe(accountA);
  });
  it("remaps 66,000 file tags without per-file query parameters", async () => {
    const f = await fixture();
    await first.db.execute(
      sql`insert into app.file_tags(identity_id, path, tag_id) select ${f.alice.id}::uuid, '/many/' || n, ${f.used.id}::uuid from generate_series(1,66000) as n`,
    );
    await a.linkVerified({ ...base, accountId: accountB });
    const result = await first.db.execute<{ count: number }>(
      sql`select count(*)::integer as count from app.file_tags ft join app.tags t on t.id=ft.tag_id where ft.identity_id=${f.alice.id} and t.account_id=${accountB}`,
    );
    expect(result.rows[0]?.count).toBe(66002);
  });
});

describe("unlink and switch", () => {
  it("unlinks into nonadmin independent account, retaining UUID, credentials and metadata", async () => {
    const f = await fixture();
    const before = await snapshot();
    await makeSession("d", accountA, f.alice.id);
    const result = await a.unlink({
      accountId: accountA,
      identityId: f.alice.id,
      at,
      requestingSessionIdHash: "a".repeat(64),
    });
    expect(result.identity.id).toBe(f.alice.id);
    expect(result.remainingIdentityId).toBe(f.sibling.id);
    expect(result.identity.accountId).not.toBe(accountA);
    const after = await snapshot();
    expect(after.accounts.find((acc) => acc.id === result.identity.accountId)).toMatchObject({
      displayName: "alice",
      isAdmin: false,
    });
    expect(after.credentials).toEqual(before.credentials);
    expect(after.favorites).toEqual(before.favorites);
    expect(after.recents).toEqual(before.recents);
    expect(after.shares).toEqual(before.shares);
    // Only the requesting session moves to the remaining login; every other
    // session that was using the unlinked login is revoked with it.
    expect(after.sessions).toEqual(
      before.sessions.map((s) =>
        s.idHash === "a".repeat(64) ? { ...s, activeIdentityId: f.sibling.id } : s,
      ),
    );
    expect(after.sessions.some((s) => s.idHash === "d".repeat(64))).toBe(false);
    expect(after.tokens).toEqual(before.tokens.filter((t) => t.identityId !== f.alice.id));
    const newTags = after.tags.filter((t) => t.accountId === result.identity.accountId);
    expect(newTags.map((t) => t.name).sort()).toEqual(["Shared", "Used"]);
    expect(
      after.fileTags
        .filter((t) => t.identityId === f.alice.id)
        .every((ft) => newTags.some((t) => t.id === ft.tagId)),
    ).toBe(true);
    expect(after.tags.filter((t) => t.accountId === accountA)).toEqual(
      before.tags.filter((t) => t.accountId === accountA),
    );
  });
  it("chooses the lowest remaining UUID consistently across sessions", async () => {
    const alice = await a.linkVerified(base);
    const firstSibling = await a.linkVerified({ ...base, username: "first-sibling" });
    const secondSibling = await a.linkVerified({ ...base, username: "second-sibling" });
    await makeSession("a", accountA, alice.id);
    await makeSession("b", accountA, alice.id);
    const expected = [firstSibling.id, secondSibling.id].sort()[0];
    const result = await a.unlink({
      accountId: accountA,
      identityId: alice.id,
      at,
      requestingSessionIdHash: "b".repeat(64),
    });
    expect(result.remainingIdentityId).toBe(expected);
    const active = await first.db
      .select({ idHash: sessions.idHash, identityId: sessions.activeIdentityId })
      .from(sessions);
    expect(active).toEqual([{ idHash: "b".repeat(64), identityId: expected }]);
  });
  it("unlink without a requesting session revokes every session using that login", async () => {
    const alice = await a.linkVerified(base);
    const sibling = await a.linkVerified({ ...base, username: "sibling" });
    await makeSession("a", accountA, alice.id);
    await makeSession("b", accountA, alice.id);
    await makeSession("c", accountA, sibling.id);
    await a.unlink({ accountId: accountA, identityId: alice.id, at });
    const remaining = await first.db.select({ idHash: sessions.idHash }).from(sessions);
    expect(remaining).toEqual([{ idHash: "c".repeat(64) }]);
  });
  it("rejects final-identity and foreign unlink without creating an account", async () => {
    const alice = await a.linkVerified(base);
    await expect(a.unlink({ accountId: accountA, identityId: alice.id, at })).rejects.toMatchObject(
      { code: "last_identity" },
    );
    await expect(a.unlink({ accountId: accountB, identityId: alice.id, at })).rejects.toMatchObject(
      { code: "forbidden" },
    );
    expect(await first.db.select().from(accounts)).toHaveLength(3);
  });
  it("serializes concurrent unlink and keeps one remaining identity", async () => {
    const alice = await a.linkVerified(base);
    const sibling = await a.linkVerified({ ...base, username: "sibling" });
    const results = await Promise.allSettled([
      a.unlink({ accountId: accountA, identityId: alice.id, at }),
      b.unlink({ accountId: accountA, identityId: sibling.id, at }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "last_identity" },
    });
    expect(
      await first.db.select().from(identities).where(eq(identities.accountId, accountA)),
    ).toHaveLength(1);
  });
  it("switches only the owned live session without extending expiry or altering other fields", async () => {
    const alice = await a.linkVerified(base);
    const sibling = await a.linkVerified({ ...base, username: "sibling" });
    const current = await makeSession("a", accountA, alice.id);
    const other = await makeSession("b", accountA, alice.id);
    await a.switchActive({
      accountId: accountA,
      sessionIdHash: current.idHash,
      identityId: sibling.id,
      at,
    });
    expect(await first.db.select().from(sessions).orderBy(asc(sessions.idHash))).toEqual([
      { ...current, activeIdentityId: sibling.id },
      other,
    ]);
  });
  it("rejects expired, absent and foreign sessions and foreign identity targets", async () => {
    const alice = await a.linkVerified(base);
    const bob = await a.linkVerified({ ...base, accountId: accountB, username: "bob" });
    await makeSession("a", accountA, alice.id, at);
    await makeSession("b", accountB, bob.id);
    const request = {
      accountId: accountA,
      identityId: alice.id,
      at,
      sessionIdHash: "a".repeat(64),
    };
    for (const hash of ["a", "b", "c"])
      await expect(
        a.switchActive({ ...request, sessionIdHash: hash.repeat(64) }),
      ).rejects.toMatchObject({ code: "invalid_session" });
    await expect(a.switchActive({ ...request, identityId: bob.id })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("rechecks ownership when unlink races a switch or verified transfer", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      a.unlink({
        accountId: accountA,
        identityId: f.alice.id,
        at,
        requestingSessionIdHash: "a".repeat(64),
      }),
      b.switchActive({
        accountId: accountA,
        identityId: f.alice.id,
        sessionIdHash: "a".repeat(64),
        at,
      }),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    const [session] = await first.db
      .select()
      .from(sessions)
      .where(eq(sessions.idHash, "a".repeat(64)));
    expect(session?.activeIdentityId).toBe(f.sibling.id);
    const next = await a.linkVerified({ ...base, username: "next" });
    const raced = await Promise.allSettled([
      a.unlink({ accountId: accountA, identityId: next.id, at }),
      b.linkVerified({ ...base, accountId: accountB, username: "next" }),
    ]);
    expect(raced[1]?.status).toBe("fulfilled");
    const [identity] = await first.db.select().from(identities).where(eq(identities.id, next.id));
    expect(identity?.accountId).toBe(accountB);
  });
  it("rolls back unlink metadata/account changes if a later DB operation fails", async () => {
    const f = await fixture();
    const before = await snapshot();
    await first.db.execute(
      sql`alter table app.sessions add constraint fail_switch check(active_identity_id is null) not valid`,
    );
    try {
      await expect(
        a.unlink({
          accountId: accountA,
          identityId: f.alice.id,
          at,
          requestingSessionIdHash: "a".repeat(64),
        }),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await first.db.execute(sql`alter table app.sessions drop constraint fail_switch`);
    }
  });
});

it("provides typed missing-resource errors and validates before touching a closed pool", async () => {
  await expect(a.linkVerified({ ...base, accountId: missing })).rejects.toEqual(
    new IdentityLinksError("missing_account"),
  );
  await expect(a.linkVerified({ ...base, providerId: missing })).rejects.toEqual(
    new IdentityLinksError("missing_provider"),
  );
  await expect(a.unlink({ accountId: accountA, identityId: missing, at })).rejects.toEqual(
    new IdentityLinksError("missing_identity"),
  );
  const alice = await a.linkVerified(base);
  await expect(a.unlink({ accountId: missing, identityId: alice.id, at })).rejects.toEqual(
    new IdentityLinksError("missing_account"),
  );
  const closed = createDb("postgresql://unused:unused@127.0.0.1:1/unused");
  await closed.close();
  const repo = createIdentityLinksRepo(closed.db);
  await expect(repo.linkVerified({ ...base, username: "" })).rejects.toThrow(TypeError);
  await expect(repo.unlink({ accountId: "bad", identityId: missing, at })).rejects.toThrow(
    TypeError,
  );
  await expect(
    repo.switchActive({ accountId: accountA, identityId: missing, sessionIdHash: "bad", at }),
  ).rejects.toThrow(TypeError);
});

describe("provider endpoint binding", () => {
  it.each(["login", "link"] as const)(
    "rejects %s verified against an endpoint that changed before persistence",
    async (operation) => {
      const repos = createRepos(first.db);
      const row = await repos.providers.ensure({
        type: "sftpgo",
        baseUrl: `http://stale-${operation}`,
      });
      const input = {
        ...base,
        providerId: row.id,
        verifiedProvider: { type: row.type, baseUrl: row.baseUrl },
      };
      await repos.providers.update(row.id, { baseUrl: `http://replacement-${operation}` });
      const result =
        operation === "link"
          ? a.linkVerified(input)
          : a.loginVerified({
              ...input,
              session: { idHash: "e".repeat(64), expiresAt: expiry, userAgent: null, ip: null },
            });
      await expect(result).rejects.toMatchObject({ code: "invalid_session" });
      expect(await repos.identities.countByProvider(row.id)).toBe(0);
    },
  );

  it.each(["login", "link"] as const)(
    "serializes a racing address update and first %s",
    async (operation) => {
      const repos = createRepos(second.db);
      const row = await repos.providers.ensure({
        type: "sftpgo",
        baseUrl: `http://race-${operation}`,
      });
      const input = {
        ...base,
        providerId: row.id,
        verifiedProvider: { type: row.type, baseUrl: row.baseUrl },
      };
      const [identityResult, addressResult] = await Promise.allSettled([
        operation === "link"
          ? a.linkVerified(input)
          : a.loginVerified({
              ...input,
              session: { idHash: "e".repeat(64), expiresAt: expiry, userAgent: null, ip: null },
            }),
        repos.providers.update(row.id, { baseUrl: `http://raced-${operation}` }),
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
    },
  );
});
