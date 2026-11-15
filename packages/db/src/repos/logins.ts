import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { accounts, credentials, identities, providers, sessions, settings } from "../schema/app.js";
import {
  LoginError,
  type LoginRepo,
  type LoginVerifiedInput,
  validateLoginVerified,
  validateSealedIdentityCredential,
} from "./logins-types.js";
import type { Identity } from "./types.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function lockVerifiedProvider(tx: Transaction, input: LoginVerifiedInput): Promise<void> {
  const [provider] = await tx
    .select()
    .from(providers)
    .where(eq(providers.id, input.providerId))
    .for("share");
  if (!provider) throw new LoginError("missing_provider");
  const expected = input.verifiedProvider;
  if (
    expected !== undefined &&
    (provider.type !== expected.type ||
      provider.baseUrl !== expected.baseUrl ||
      (!provider.enabled && !expected.allowDisabled))
  ) {
    throw new LoginError("invalid_session");
  }
}

/** Serializes sign-ins of one username, so a first sign-in creates one account. */
async function lockLogin(tx: Transaction, providerId: string, username: string): Promise<void> {
  const key = JSON.stringify(["login", providerId, username]);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function storeCredential(
  tx: Transaction,
  identityId: string,
  input: Pick<LoginVerifiedInput, "at" | "sealCredential">,
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

export function createLoginRepo(db: Db): LoginRepo {
  return {
    async loginVerified(input) {
      validateLoginVerified(input);
      return db.transaction(async (tx) => {
        await lockLogin(tx, input.providerId, input.username);
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
          const [updated] = await tx
            .update(identities)
            .set({ lastLoginAt: input.at })
            .where(eq(identities.id, existing.id))
            .returning();
          if (!updated) throw new LoginError("missing_identity");
          identity = updated;
          const [currentCredential] = await tx
            .select()
            .from(credentials)
            .where(eq(credentials.identityId, identity.id));
          const revoke =
            input.compareCredential?.(identity.id, currentCredential ?? null) ??
            input.revokeOtherSessions;
          if (revoke === true)
            await tx.delete(sessions).where(eq(sessions.accountId, identity.accountId));
        } else {
          const [account] = await tx
            .insert(accounts)
            .values({ displayName: input.username, isAdmin: false, createdAt: input.at })
            .returning();
          if (!account) throw new LoginError("missing_account");
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
          if (!created) throw new LoginError("missing_identity");
          identity = created;
        }
        if (input.setupClaim !== undefined) {
          const desired = {
            version: 1,
            state: "claiming",
            accountId: identity.accountId,
            baseUrl: input.setupClaim.baseUrl,
          };
          const [claim] = await tx
            .insert(settings)
            .values({ key: input.setupClaim.key, value: desired })
            .onConflictDoUpdate({
              target: settings.key,
              set: { value: desired },
              setWhere: sql`${settings.value} = ${JSON.stringify(desired)}::jsonb`,
            })
            .returning();
          if (!claim) throw new LoginError("setup_claimed");
        }
        await storeCredential(tx, identity.id, input);
        const [session] = await tx
          .insert(sessions)
          .values({
            ...input.session,
            accountId: identity.accountId,
            identityId: identity.id,
            createdAt: input.at,
            lastSeenAt: input.at,
          })
          .returning();
        if (!session) throw new LoginError("invalid_session");
        return { identity, session };
      });
    },
  };
}
