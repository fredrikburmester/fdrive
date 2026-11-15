import { eq, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { accounts, identities, localUsers, sessions, settings } from "../schema/app.js";
import {
  LoginError,
  type LoginRepo,
  type NewLocalUser,
  SETUP_OWNER_KEY,
  type SetupOwner,
  validateNewLocalUser,
  validateSignIn,
} from "./logins-types.js";
import { isUniqueViolation } from "./pg-errors.js";
import { ConflictError, type Identity } from "./types.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The user, then the login a removed user of this name left behind, else a new account and login. */
async function insertUser(tx: Transaction, input: NewLocalUser): Promise<Identity> {
  await tx.insert(localUsers).values({
    username: input.username,
    passwordHash: input.passwordHash,
    createdAt: input.at,
    updatedAt: input.at,
  });
  const [left] = await tx
    .select()
    .from(identities)
    .where(eq(identities.externalUsername, input.username));
  if (left !== undefined) {
    await tx
      .update(accounts)
      .set({ isAdmin: input.isAdmin })
      .where(eq(accounts.id, left.accountId));
    return left;
  }
  const [account] = await tx
    .insert(accounts)
    .values({ displayName: input.username, isAdmin: input.isAdmin, createdAt: input.at })
    .returning();
  if (account === undefined) throw new Error("account insert returned no row");
  const [identity] = await tx
    .insert(identities)
    .values({
      accountId: account.id,
      providerId: input.providerId,
      externalUsername: input.username,
      createdAt: input.at,
    })
    .returning();
  if (identity === undefined) throw new Error("login insert returned no row");
  return identity;
}

/** A name taken in any case, by a user or by a login a removed user left, is a conflict. */
async function creating<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("username already exists");
    throw error;
  }
}

export function createLoginRepo(db: Db): LoginRepo {
  return {
    createUser(input) {
      validateNewLocalUser(input);
      return creating(() => db.transaction((tx) => insertUser(tx, input)));
    },

    setup(input) {
      validateNewLocalUser(input);
      return creating(() =>
        db.transaction(async (tx) => {
          const identity = await insertUser(tx, { ...input, isAdmin: true });
          const owner: SetupOwner = { state: "complete", accountId: identity.accountId };
          const [claimed] = await tx
            .insert(settings)
            .values({ key: SETUP_OWNER_KEY, value: owner })
            .onConflictDoNothing()
            .returning();
          if (claimed === undefined) throw new LoginError("setup_claimed");
          return identity;
        }),
      );
    },

    async signIn(input) {
      validateSignIn(input);
      return db.transaction(async (tx) => {
        const [identity] = await tx
          .update(identities)
          .set({ lastLoginAt: input.at })
          .where(sql`lower(${identities.externalUsername}) = lower(${input.username})`)
          .returning();
        if (identity === undefined) throw new LoginError("missing_identity");
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
        if (session === undefined) throw new Error("session insert returned no row");
        return { identity, session };
      });
    },
  };
}
