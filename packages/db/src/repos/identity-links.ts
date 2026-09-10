import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import {
  accounts,
  apiTokens,
  credentials,
  identities,
  providers,
  sessions,
} from "../schema/app.js";
import {
  IdentityLinksError,
  type IdentityLinksRepo,
  type LinkVerifiedInput,
  validateLinkVerified,
  validateLoginVerified,
  validateRotateSession,
  validateSealedIdentityCredential,
  validateSwitchActiveIdentity,
  validateUnlinkIdentity,
} from "./identity-links-types.js";
import type { Identity, Session } from "./types.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function lockVerifiedProvider(
  tx: Transaction,
  input: Pick<LinkVerifiedInput, "providerId" | "verifiedProvider">,
): Promise<void> {
  const [provider] = await tx
    .select()
    .from(providers)
    .where(eq(providers.id, input.providerId))
    .for("share");
  if (!provider) throw new IdentityLinksError("missing_provider");
  const expected = input.verifiedProvider;
  if (
    expected !== undefined &&
    (provider.type !== expected.type ||
      provider.baseUrl !== expected.baseUrl ||
      (!provider.enabled && !expected.allowDisabled))
  ) {
    throw new IdentityLinksError("invalid_session");
  }
}

async function lockLocation(tx: Transaction, providerId: string, username: string): Promise<void> {
  const key = JSON.stringify(["identity-links", providerId, username]);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
async function lockAccounts(tx: Transaction, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  const rows = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(inArray(accounts.id, unique))
    .orderBy(asc(accounts.id))
    .for("update");
  if (rows.length !== unique.length) throw new IdentityLinksError("missing_account");
}
async function findIdentity(tx: Transaction, id: string): Promise<Identity> {
  const [identity] = await tx.select().from(identities).where(eq(identities.id, id));
  if (!identity) throw new IdentityLinksError("missing_identity");
  return identity;
}
async function lockOwnedIdentity(
  tx: Transaction,
  accountId: string,
  identityId: string,
): Promise<Identity> {
  const initial = await findIdentity(tx, identityId);
  await lockLocation(tx, initial.providerId, initial.externalUsername);
  await lockAccounts(tx, [accountId]);
  const identity = await findIdentity(tx, identityId);
  if (identity.accountId !== accountId) throw new IdentityLinksError("forbidden");
  return identity;
}
async function transferMetadata(
  tx: Transaction,
  identity: Identity,
  accountId: string,
): Promise<void> {
  await tx.execute(sql`
    insert into app.tags (account_id, name, color)
    select distinct ${accountId}::uuid, source.name, source.color
    from app.tags as source
    join app.file_tags as ft on ft.tag_id = source.id
    where ft.identity_id = ${identity.id} and source.account_id = ${identity.accountId}
    on conflict (account_id, name) do nothing
  `);
  await tx.execute(sql`
    insert into app.file_tags (identity_id, path, tag_id)
    select ft.identity_id, ft.path, target.id
    from app.file_tags as ft
    join app.tags as source on source.id = ft.tag_id and source.account_id = ${identity.accountId}
    join app.tags as target on target.account_id = ${accountId} and target.name = source.name
    where ft.identity_id = ${identity.id}
    on conflict (identity_id, path, tag_id) do nothing
  `);
  await tx.execute(sql`
    delete from app.file_tags as ft using app.tags as source
    where ft.tag_id = source.id and ft.identity_id = ${identity.id}
      and source.account_id = ${identity.accountId}
  `);
}

async function requireLiveSession(
  tx: Transaction,
  accountId: string,
  idHash: string,
  at: Date,
): Promise<Session> {
  const [session] = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.idHash, idHash),
        eq(sessions.accountId, accountId),
        gt(sessions.expiresAt, at),
      ),
    )
    .for("update");
  if (!session) throw new IdentityLinksError("invalid_session");
  return session;
}
async function storeCredential(
  tx: Transaction,
  identityId: string,
  input: Pick<LinkVerifiedInput, "at" | "sealCredential">,
): Promise<void> {
  const sealed = input.sealCredential(identityId);
  validateSealedIdentityCredential(sealed);
  const values = {
    identityId,
    ciphertext: Buffer.from(sealed.ciphertext),
    keyId: sealed.keyId,
    cachedToken: null,
    cachedTokenExpiresAt: null,
    updatedAt: input.at,
  };
  await tx
    .insert(credentials)
    .values(values)
    .onConflictDoUpdate({ target: credentials.identityId, set: values });
}

export function createIdentityLinksRepo(db: Db): IdentityLinksRepo {
  return {
    async loginVerified(input) {
      validateLoginVerified(input);
      return db.transaction(async (tx) => {
        await lockLocation(tx, input.providerId, input.username);
        await lockVerifiedProvider(tx, input);
        const [existing] = await tx
          .select()
          .from(identities)
          .where(
            and(
              eq(identities.providerId, input.providerId),
              eq(identities.externalUsername, input.username),
            ),
          );
        let identity: Identity;
        if (existing) {
          await lockAccounts(tx, [existing.accountId]);
          identity = await findIdentity(tx, existing.id);
          if (identity.accountId !== existing.accountId) throw new IdentityLinksError("forbidden");
          const [updated] = await tx
            .update(identities)
            .set({ lastLoginAt: input.at })
            .where(eq(identities.id, identity.id))
            .returning();
          if (!updated) throw new IdentityLinksError("missing_identity");
          identity = updated;
          if (input.revokeOtherSessions === true)
            await tx.delete(sessions).where(eq(sessions.accountId, identity.accountId));
        } else {
          const [account] = await tx
            .insert(accounts)
            .values({ displayName: input.username, isAdmin: false, createdAt: input.at })
            .returning();
          if (!account) throw new IdentityLinksError("missing_account");
          const [created] = await tx
            .insert(identities)
            .values({
              accountId: account.id,
              providerId: input.providerId,
              externalUsername: input.username,
              createdAt: input.at,
              lastLoginAt: input.at,
            })
            .returning();
          if (!created) throw new IdentityLinksError("missing_identity");
          identity = created;
        }
        await storeCredential(tx, identity.id, input);
        const [session] = await tx
          .insert(sessions)
          .values({
            ...input.session,
            accountId: identity.accountId,
            activeIdentityId: identity.id,
            createdAt: input.at,
            lastSeenAt: input.at,
          })
          .returning();
        if (!session) throw new IdentityLinksError("invalid_session");
        return { identity, session };
      });
    },
    async rotateSession(input) {
      validateRotateSession(input);
      return db.transaction(async (tx) => {
        await lockOwnedIdentity(tx, input.accountId, input.activeIdentityId);
        const old = await requireLiveSession(tx, input.accountId, input.oldSessionIdHash, input.at);
        const [session] = await tx
          .insert(sessions)
          .values({
            idHash: input.newSessionIdHash,
            accountId: input.accountId,
            activeIdentityId: input.activeIdentityId,
            expiresAt: old.expiresAt,
            userAgent: old.userAgent,
            ip: old.ip,
            // The rotated session is the same login, so its absolute age
            // (`createdAt`) carries over; only `lastSeenAt` is now.
            createdAt: old.createdAt,
            lastSeenAt: input.at,
          })
          .returning();
        if (!session) throw new IdentityLinksError("invalid_session");
        await tx.delete(sessions).where(eq(sessions.idHash, old.idHash));
        return session;
      });
    },
    async linkVerified(input) {
      validateLinkVerified(input);
      return db.transaction(async (tx) => {
        await lockLocation(tx, input.providerId, input.username);
        const [existing] = await tx
          .select()
          .from(identities)
          .where(
            and(
              eq(identities.providerId, input.providerId),
              eq(identities.externalUsername, input.username),
            ),
          );
        await lockAccounts(
          tx,
          existing ? [input.accountId, existing.accountId] : [input.accountId],
        );
        await lockVerifiedProvider(tx, input);
        if (input.requestingSessionIdHash !== undefined)
          await requireLiveSession(tx, input.accountId, input.requestingSessionIdHash, input.at);
        let identity: Identity;
        if (existing) {
          identity = await findIdentity(tx, existing.id);
          if (identity.accountId !== existing.accountId) throw new IdentityLinksError("forbidden");
          if (identity.accountId !== input.accountId) {
            await transferMetadata(tx, identity, input.accountId);
            await tx
              .delete(sessions)
              .where(
                and(
                  eq(sessions.accountId, identity.accountId),
                  eq(sessions.activeIdentityId, identity.id),
                ),
              );
            await tx.delete(apiTokens).where(eq(apiTokens.identityId, identity.id));
          }
          const [updated] = await tx
            .update(identities)
            .set({ accountId: input.accountId, lastLoginAt: input.at })
            .where(eq(identities.id, identity.id))
            .returning();
          if (!updated) throw new IdentityLinksError("missing_identity");
          identity = updated;
        } else {
          const [created] = await tx
            .insert(identities)
            .values({
              accountId: input.accountId,
              providerId: input.providerId,
              externalUsername: input.username,
              createdAt: input.at,
              lastLoginAt: input.at,
            })
            .returning();
          if (!created) throw new IdentityLinksError("missing_identity");
          identity = created;
        }
        await storeCredential(tx, identity.id, input);
        return identity;
      });
    },
    async unlink(input) {
      validateUnlinkIdentity(input);
      return db.transaction(async (tx) => {
        const identity = await lockOwnedIdentity(tx, input.accountId, input.identityId);
        if (input.requestingSessionIdHash !== undefined)
          await requireLiveSession(tx, input.accountId, input.requestingSessionIdHash, input.at);
        const [remaining] = await tx
          .select({ id: identities.id })
          .from(identities)
          .where(
            and(eq(identities.accountId, input.accountId), ne(identities.id, input.identityId)),
          )
          .orderBy(asc(identities.id))
          .limit(1);
        if (!remaining) throw new IdentityLinksError("last_identity");
        const [account] = await tx
          .insert(accounts)
          .values({ displayName: identity.externalUsername, isAdmin: false, createdAt: input.at })
          .returning();
        if (!account) throw new IdentityLinksError("missing_account");
        await transferMetadata(tx, identity, account.id);
        const [updated] = await tx
          .update(identities)
          .set({ accountId: account.id })
          .where(eq(identities.id, identity.id))
          .returning();
        if (!updated) throw new IdentityLinksError("missing_identity");
        await tx.delete(apiTokens).where(eq(apiTokens.identityId, identity.id));
        // Sessions that were using the unlinked login end with it; only the
        // requesting session survives, moved to a remaining login so the
        // caller can rotate it.
        const active = and(
          eq(sessions.accountId, input.accountId),
          eq(sessions.activeIdentityId, identity.id),
        );
        await tx
          .delete(sessions)
          .where(
            input.requestingSessionIdHash === undefined
              ? active
              : and(active, ne(sessions.idHash, input.requestingSessionIdHash)),
          );
        await tx.update(sessions).set({ activeIdentityId: remaining.id }).where(active);
        return { identity: updated, remainingIdentityId: remaining.id };
      });
    },
    async switchActive(input) {
      validateSwitchActiveIdentity(input);
      await db.transaction(async (tx) => {
        await lockOwnedIdentity(tx, input.accountId, input.identityId);
        const [updated] = await tx
          .update(sessions)
          .set({ activeIdentityId: input.identityId })
          .where(
            and(
              eq(sessions.idHash, input.sessionIdHash),
              eq(sessions.accountId, input.accountId),
              gt(sessions.expiresAt, input.at),
            ),
          )
          .returning({ id: sessions.idHash });
        if (!updated) throw new IdentityLinksError("invalid_session");
      });
    },
  };
}
