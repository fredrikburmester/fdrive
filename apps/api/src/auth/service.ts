import type { IdentitySummary, MeResponse } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import { LoginError, type Repos } from "@fdrive/db";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import type { ProviderService } from "../providers/service.js";
import type { CheckPassword } from "./password.ts";
import type { Principal } from "./principal.js";
import { COOKIE_NAME, generateSessionId, hashSessionId } from "./sessions.js";
import { type IdentityStorageFactory, unavailableStorage } from "./storage-factory.ts";

/** How stale a session's `lastSeenAt` must be before `resolvePrincipal` slides its expiry. */
const SLIDING_TOUCH_THRESHOLD_MS = 5 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface LoginInput {
  /** A local user's name, in any case. */
  readonly username: string;
  readonly password: string;
  readonly userAgent: string | null;
  readonly ip: string;
}

export interface LoginResult {
  readonly sessionId: string;
  readonly me: MeResponse;
}

export interface AuthService {
  login(input: LoginInput): Promise<LoginResult>;
  resolvePrincipal(c: Context): Promise<Principal | null>;
  me(accountId: string, identityId: string): Promise<MeResponse>;
  logout(sessionId: string): Promise<void>;
}

export interface CreateAuthServiceDeps {
  readonly repos: Repos;
  readonly providers: Pick<ProviderService, "get" | "capabilitiesFor" | "labelFor">;
  readonly clock: () => Date;
  readonly config: AppConfig;
  readonly checkPassword: CheckPassword;
  readonly storageFactory: IdentityStorageFactory;
  /** Usernames always treated as admins, in addition to `accounts.is_admin`. */
  readonly adminUsernames: readonly string[];
}

/** Builds the `AuthService`, the API's sign-in and session flow. */
export function createAuthService(deps: CreateAuthServiceDeps): AuthService {
  async function isEnvironmentAdmin(identity: {
    providerId: string;
    externalUsername: string;
  }): Promise<boolean> {
    // Only the storage the deployment pins (the local folder) can name an
    // administrator: the same username on storage an administrator added
    // later is another person.
    if (!deps.adminUsernames.includes(identity.externalUsername)) return false;
    const resolved = await deps.providers.get(identity.providerId);
    return resolved?.provider.managedByEnv === true;
  }

  /** The login as `/auth/me` shows it; `null` when this deployment has no module for its storage. */
  async function summarize(identity: {
    id: string;
    providerId: string;
    externalUsername: string;
  }): Promise<IdentitySummary | null> {
    const resolved = await deps.providers.get(identity.providerId);
    if (resolved === null) return null;
    return {
      id: identity.id,
      username: identity.externalUsername,
      providerId: resolved.provider.id,
      providerType: resolved.module.type as IdentitySummary["providerType"],
      providerLabel: deps.providers.labelFor(resolved.provider),
      capabilities: await deps.providers.capabilitiesFor(resolved),
    };
  }

  async function me(accountId: string, identityId: string): Promise<MeResponse> {
    const account = await deps.repos.accounts.get(accountId);
    if (!account) {
      throw new ApiHttpError("internal", "account for active session no longer exists");
    }
    const identity = await deps.repos.identities.get(identityId);
    if (identity === null) throw new ApiHttpError("unauthorized", "sign in again");
    const summary = await summarize(identity);
    if (summary === null) {
      throw new ApiHttpError("unauthorized", "storage provider no longer exists");
    }
    return {
      account: { id: account.id, displayName: account.displayName },
      identity: summary,
      isAdmin: account.isAdmin || (await isEnvironmentAdmin(identity)),
    };
  }

  async function login(input: LoginInput): Promise<LoginResult> {
    const username = await deps.checkPassword({
      username: input.username,
      password: input.password,
      ip: input.ip,
    });
    const rawSessionId = generateSessionId();
    const idHash = hashSessionId(rawSessionId);
    const at = deps.clock();
    let identity: { id: string; accountId: string };
    try {
      ({ identity } = await deps.repos.logins.signIn({
        username,
        at,
        session: {
          idHash,
          expiresAt: new Date(at.getTime() + deps.config.fdriveSessionTtlDays * MS_PER_DAY),
          userAgent: input.userAgent,
          ip: input.ip,
        },
      }));
    } catch (error) {
      // Never sends raw SQL errors, which may carry bind values, to the logger.
      if (error instanceof LoginError)
        throw new ApiHttpError("unauthorized", "sign-in is not possible");
      throw new ApiHttpError("internal", "sign-in failed");
    }
    try {
      return { sessionId: rawSessionId, me: await me(identity.accountId, identity.id) };
    } catch (error) {
      await deps.repos.sessions.delete(idHash);
      throw error;
    }
  }

  async function resolvePrincipal(c: Context): Promise<Principal | null> {
    const rawSessionId = getCookie(c, COOKIE_NAME);
    if (rawSessionId === undefined) {
      return null;
    }

    const idHash = hashSessionId(rawSessionId);
    const now = deps.clock();
    const session = await deps.repos.sessions.getByIdHash(idHash, now);
    if (!session) {
      return null;
    }
    // Sliding expiry keeps an active session alive, but never beyond a fixed
    // age from login: a stolen session id cannot be kept valid indefinitely
    // by periodic use.
    if (
      now.getTime() - session.createdAt.getTime() >=
      deps.config.fdriveSessionMaxAgeDays * MS_PER_DAY
    ) {
      await deps.repos.sessions.delete(idHash);
      return null;
    }

    if (now.getTime() - session.lastSeenAt.getTime() > SLIDING_TOUCH_THRESHOLD_MS) {
      await deps.repos.sessions.touch(idHash, {
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + deps.config.fdriveSessionTtlDays * MS_PER_DAY),
      });
    }

    const identity = await deps.repos.identities.get(session.identityId);
    if (identity === null) return null;

    const account = await deps.repos.accounts.get(session.accountId);
    const isAdmin = (account?.isAdmin ?? false) || (await isEnvironmentAdmin(identity));

    const verifyAuthority = async (): Promise<boolean> => {
      const at = deps.clock();
      const current = await deps.repos.sessions.getByIdHash(idHash, at);
      return (
        current !== null &&
        at.getTime() - current.createdAt.getTime() <
          deps.config.fdriveSessionMaxAgeDays * MS_PER_DAY
      );
    };

    // A provider an admin disabled must not take the session down with it:
    // the account's own routes keep working and only storage calls fail.
    let storage: StorageProvider;
    try {
      storage = await deps.storageFactory(identity.id);
    } catch (error) {
      if (!(error instanceof ApiHttpError && error.kind === "upstream_unavailable")) {
        throw error;
      }
      storage = unavailableStorage(error);
    }

    return {
      accountId: session.accountId,
      identityId: identity.id,
      username: identity.externalUsername,
      storage,
      isAdmin,
      verifyAuthority,
    };
  }

  async function logout(sessionId: string): Promise<void> {
    await deps.repos.sessions.delete(hashSessionId(sessionId));
  }

  return {
    login,
    resolvePrincipal,
    me,
    logout,
  };
}
