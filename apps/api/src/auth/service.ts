import type { IdentitySummary, MeResponse } from "@fdrive/contracts";
import { type StorageProvider, sameCredential } from "@fdrive/core";
import { type Credential, LoginError, type LoginRepo, type Repos } from "@fdrive/db";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { verifyCredentials } from "../accounts/credentials.ts";
import type { AppConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import type { ProviderService } from "../providers/service.js";
import { KEY_ID, open, seal } from "./crypto.js";
import type { LoginLimiter } from "./login-limiter.js";
import type { Principal } from "./principal.js";
import { COOKIE_NAME, generateSessionId, hashSessionId } from "./sessions.js";
import { type IdentityStorageFactory, unavailableStorage } from "./storage-factory.ts";
import { parseStoredCredential } from "./stored-credential.ts";

/** How stale a session's `lastSeenAt` must be before `resolvePrincipal` slides its expiry. */
const SLIDING_TOUCH_THRESHOLD_MS = 5 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface LoginInput {
  /** Omitted when exactly one provider is enabled. */
  readonly providerId?: string | undefined;
  /** Values for the provider's `credentialFields`. */
  readonly credential: Readonly<Record<string, string>>;
  readonly userAgent: string | null;
  readonly ip: string;
}

export interface LoginResult {
  readonly sessionId: string;
  readonly me: MeResponse;
}

export interface AuthService {
  login(input: LoginInput): Promise<LoginResult>;
  /** Verifies against a provider that may not be enabled yet and creates a session bound to it. */
  loginCandidate(
    input: LoginInput,
    providerId: string,
    setupClaimKey?: string,
  ): Promise<LoginResult>;
  resolvePrincipal(c: Context): Promise<Principal | null>;
  me(accountId: string, identityId: string): Promise<MeResponse>;
  logout(sessionId: string): Promise<void>;
}

export interface CreateAuthServiceDeps {
  readonly repos: Repos;
  readonly logins: LoginRepo;
  readonly providers: Pick<
    ProviderService,
    "resolve" | "enabled" | "get" | "capabilitiesFor" | "labelFor"
  >;
  readonly fetch: typeof globalThis.fetch;
  readonly master: Uint8Array;
  readonly clock: () => Date;
  readonly config: AppConfig;
  readonly limiter: LoginLimiter;
  readonly storageFactory: IdentityStorageFactory;
  /** Usernames always treated as admins, in addition to `accounts.is_admin`. */
  readonly adminUsernames: readonly string[];
}

/** Never sends raw SQL errors, which may carry credential bind values, to the logger. */
async function loginCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiHttpError) throw error;
    if (error instanceof LoginError) {
      if (error.code === "setup_claimed")
        throw new ApiHttpError("conflict", "this server has already been claimed by another owner");
      throw new ApiHttpError(
        error.code === "missing_identity" || error.code === "missing_provider"
          ? "not_found"
          : "unauthorized",
        "sign-in is not possible",
      );
    }
    throw new ApiHttpError("internal", "sign-in failed");
  }
}

/** Builds the `AuthService`, the credential-mode login/session flow for the API. */
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

  async function loginAt(
    input: LoginInput,
    candidateProviderId: string | null,
    setupClaimKey?: string,
  ): Promise<LoginResult> {
    let observed: Credential | null = null;
    const verified = await verifyCredentials(
      { repos: deps.repos, providers: deps.providers, limiter: deps.limiter, fetch: deps.fetch },
      {
        providerId: candidateProviderId ?? input.providerId,
        credential: input.credential,
        ip: input.ip,
      },
      {
        allowDisabled: candidateProviderId !== null,
        beforeAuthenticate: async (providerId, username) => {
          const identity = await deps.repos.identities.findByProviderUsername(providerId, username);
          observed = identity === null ? null : await deps.repos.credentials.get(identity.id);
        },
      },
    );
    const rawSessionId = generateSessionId();
    const idHash = hashSessionId(rawSessionId);
    const at = deps.clock();
    const result = await loginCall(() =>
      deps.logins.loginVerified({
        providerId: verified.provider.id,
        verifiedProvider: {
          type: verified.provider.type,
          baseUrl: verified.provider.baseUrl,
          allowDisabled: candidateProviderId !== null,
        },
        username: verified.externalUsername,
        ...(setupClaimKey === undefined
          ? {}
          : { setupClaim: { key: setupClaimKey, baseUrl: verified.provider.baseUrl } }),
        at,
        compareCredential: (identityId, current) => {
          if (current !== null) {
            try {
              const previous = parseStoredCredential(
                open(deps.master, current.ciphertext, identityId),
              );
              if (sameCredential(verified.module.credentialFields, previous, verified.stored))
                return false;
            } catch {
              // An unreadable credential is a replacement, provided it has not changed in flight.
            }
          }
          const unchanged =
            current === null
              ? observed === null
              : observed !== null &&
                observed.identityId === identityId &&
                Buffer.from(current.ciphertext).equals(Buffer.from(observed.ciphertext));
          if (!unchanged)
            throw new ApiHttpError("unauthorized", "credentials changed during sign-in; try again");
          return true;
        },
        sealCredential: (identityId) => ({
          ciphertext: seal(
            deps.master,
            new TextEncoder().encode(JSON.stringify(verified.stored)),
            identityId,
          ),
          keyId: KEY_ID,
        }),
        session: {
          idHash,
          expiresAt: new Date(at.getTime() + deps.config.fdriveSessionTtlDays * MS_PER_DAY),
          userAgent: input.userAgent,
          ip: input.ip,
        },
      }),
    );
    try {
      return {
        sessionId: rawSessionId,
        me: await me(result.identity.accountId, result.identity.id),
      };
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
    login: (input) => loginCall(() => loginAt(input, null)),
    loginCandidate: (input, providerId, setupClaimKey) =>
      loginCall(() => loginAt(input, providerId, setupClaimKey)),
    resolvePrincipal,
    me,
    logout,
  };
}
