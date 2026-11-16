import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { accounts, apiTokens, identities, localUsers, sessions, settings } from "../schema/app.js";
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
import { ConflictError, type Identity, type LocalUser } from "./types.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Pick<Db, "execute">;

/**
 * Serializes every write that creates users or could leave fdrive without an
 * administrator: setup, adding a user, and disabling, demoting or removing
 * one. Held until the transaction ends.
 */
async function lockUsers(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('fdrive.users', 0))`);
}

/** A fresh install: no owner record, no user, no account and no login. */
async function isFresh(db: Executor): Promise<boolean> {
  const result = await db.execute<{ fresh: boolean }>(sql`
    select not exists (select 1 from ${settings} where ${settings.key} = ${SETUP_OWNER_KEY})
      and not exists (select 1 from ${localUsers})
      and not exists (select 1 from ${accounts})
      and not exists (select 1 from ${identities}) as fresh
  `);
  return result.rows[0]?.fresh === true;
}

/** How many users may administer fdrive: enabled, with an administrator account. */
async function enabledAdmins(tx: Transaction): Promise<number> {
  const result = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
    from ${localUsers}
    join ${identities} on ${identities.username} = ${localUsers.username}
    join ${accounts} on ${accounts.id} = ${identities.accountId}
    where ${accounts.isAdmin} and not ${localUsers.disabled}
  `);
  return result.rows[0]?.count ?? 0;
}

async function insertLocalUser(
  tx: Transaction,
  input: Omit<NewLocalUser, "isAdmin">,
): Promise<void> {
  await tx.insert(localUsers).values({
    username: input.username,
    passwordHash: input.passwordHash,
    createdAt: input.at,
    updatedAt: input.at,
  });
}

/** A new account and login for `input`'s user, never one left behind. */
async function insertAccountAndLogin(tx: Transaction, input: NewLocalUser): Promise<Identity> {
  const [account] = await tx
    .insert(accounts)
    .values({ displayName: input.username, isAdmin: input.isAdmin, createdAt: input.at })
    .returning();
  if (account === undefined) throw new Error("account insert returned no row");
  const [identity] = await tx
    .insert(identities)
    .values({
      accountId: account.id,
      username: input.username,
      createdAt: input.at,
    })
    .returning();
  if (identity === undefined) throw new Error("login insert returned no row");
  return identity;
}

/** The user (matched in any case), their login and whether their account is an administrator's. */
async function userWithLogin(
  tx: Transaction,
  username: string,
): Promise<{ user: LocalUser; login: Identity; isAdmin: boolean } | null> {
  const [user] = await tx
    .select()
    .from(localUsers)
    .where(sql`lower(${localUsers.username}) = lower(${username})`);
  if (user === undefined) return null;
  const [row] = await tx
    .select({ login: identities, isAdmin: accounts.isAdmin })
    .from(identities)
    .innerJoin(accounts, eq(accounts.id, identities.accountId))
    .where(eq(identities.username, user.username));
  if (row === undefined) throw new LoginError("missing_identity");
  return { user, login: row.login, isAdmin: row.isAdmin };
}

/**
 * A login's columns, for a query that joins `identities` and `accounts` and
 * left joins the login's `local_users` row: a removed user has none.
 */
const loginColumns = {
  identityId: identities.id,
  accountId: identities.accountId,
  username: identities.username,
  displayName: accounts.displayName,
  isAdmin: accounts.isAdmin,
  active: sql<boolean>`coalesce(not ${localUsers.disabled}, false)`,
};
const toAccount = eq(accounts.id, identities.accountId);
const toUser = eq(localUsers.username, identities.username);

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
    async get(identityId) {
      const [row] = await db
        .select(loginColumns)
        .from(identities)
        .innerJoin(accounts, toAccount)
        .leftJoin(localUsers, toUser)
        .where(eq(identities.id, identityId));
      return row ?? null;
    },

    async bySession(idHash, now) {
      const [row] = await db
        .select({ session: sessions, login: loginColumns })
        .from(sessions)
        .innerJoin(identities, eq(identities.id, sessions.identityId))
        .innerJoin(accounts, toAccount)
        .leftJoin(localUsers, toUser)
        .where(and(eq(sessions.idHash, idHash), gt(sessions.expiresAt, now)));
      return row ?? null;
    },

    async byToken(tokenHash) {
      const [row] = await db
        .select({ token: apiTokens, login: loginColumns })
        .from(apiTokens)
        .innerJoin(identities, eq(identities.id, apiTokens.identityId))
        .innerJoin(accounts, toAccount)
        .leftJoin(localUsers, toUser)
        .where(eq(apiTokens.tokenHash, tokenHash));
      return row ?? null;
    },

    async createUser(input) {
      validateNewLocalUser(input);
      return creating(() =>
        db.transaction(async (tx) => {
          await lockUsers(tx);
          await insertLocalUser(tx, input);
          const [left] = await tx
            .select()
            .from(identities)
            .where(eq(identities.username, input.username));
          if (left === undefined) return insertAccountAndLogin(tx, input);
          await tx
            .update(accounts)
            .set({ isAdmin: input.isAdmin })
            .where(eq(accounts.id, left.accountId));
          return left;
        }),
      );
    },

    async setup(input) {
      validateNewLocalUser(input);
      return creating(() =>
        db.transaction(async (tx) => {
          await lockUsers(tx);
          if (!(await isFresh(tx))) throw new LoginError("setup_claimed");
          await insertLocalUser(tx, input);
          const identity = await insertAccountAndLogin(tx, { ...input, isAdmin: true });
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

    setupOpen() {
      return isFresh(db);
    },

    async updateUser(username, patch) {
      return db.transaction(async (tx) => {
        await lockUsers(tx);
        const found = await userWithLogin(tx, username);
        if (found === null) return null;
        const wasAdmin = found.isAdmin && !found.user.disabled;
        const staysAdmin =
          (patch.isAdmin ?? found.isAdmin) && !(patch.disabled ?? found.user.disabled);
        if (wasAdmin && !staysAdmin && (await enabledAdmins(tx)) <= 1) {
          throw new LoginError("last_admin");
        }
        const [updated] = await tx
          .update(localUsers)
          .set({
            ...(patch.passwordHash === undefined ? {} : { passwordHash: patch.passwordHash }),
            ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
            ...(patch.storageLimit === undefined ? {} : { storageLimit: patch.storageLimit }),
            updatedAt: patch.at,
          })
          .where(eq(localUsers.username, found.user.username))
          .returning();
        if (patch.isAdmin !== undefined) {
          await tx
            .update(accounts)
            .set({ isAdmin: patch.isAdmin })
            .where(eq(accounts.id, found.login.accountId));
        }
        return { user: updated ?? found.user, login: found.login };
      });
    },

    async removeUser(username) {
      return db.transaction(async (tx) => {
        await lockUsers(tx);
        const found = await userWithLogin(tx, username);
        if (found === null) return null;
        if (found.isAdmin && !found.user.disabled && (await enabledAdmins(tx)) <= 1) {
          throw new LoginError("last_admin");
        }
        await tx.delete(localUsers).where(eq(localUsers.username, found.user.username));
        await tx
          .update(accounts)
          .set({ isAdmin: false })
          .where(eq(accounts.id, found.login.accountId));
        return found.login;
      });
    },

    async signIn(input) {
      validateSignIn(input);
      return db.transaction(async (tx) => {
        const [identity] = await tx
          .update(identities)
          .set({ lastLoginAt: input.at })
          .where(sql`lower(${identities.username}) = lower(${input.username})`)
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
