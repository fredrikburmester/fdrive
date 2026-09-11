import { IDENTITY_HEADER, type IdentitySummary, type MeResponse } from "@fdrive/contracts";
import { type StorageProvider, sameCredential } from "@fdrive/core";
import type { Credential, Repos } from "@fdrive/db";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { verifyCredentials } from "../accounts/credentials.ts";
import { accountRepositoryCall } from "../accounts/errors.ts";
import type { AccountIdentityOperations } from "../accounts/types.ts";
import type { AppConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import type { ProviderService } from "../providers/service.js";
import { KEY_ID, open, seal } from "./crypto.js";
import type { LoginLimiter } from "./login-limiter.js";
import type { Principal } from "./principal.js";
import { COOKIE_NAME, generateSessionId, hashSessionId } from "./sessions.js";
import { type IdentityStorageFactory, unavailableStorage } from "./storage-factory.ts";
import { parseStoredCredential, type TokenSource } from "./token-source.js";

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
  me(accountId: string, activeIdentityId: string): Promise<MeResponse>;
  logout(sessionId: string): Promise<void>;
}

export interface CreateAuthServiceDeps {
  readonly repos: Repos;
  readonly identityLinks: AccountIdentityOperations;
  readonly providers: Pick<
    ProviderService,
    "resolve" | "enabled" | "get" | "capabilitiesFor" | "labelFor"
  >;
  readonly fetch: typeof globalThis.fetch;
  readonly master: Uint8Array;
  readonly clock: () => Date;
  readonly config: AppConfig;
  readonly limiter: LoginLimiter;
  readonly tokenSource: Pick<TokenSource, "prime">;
  readonly storageFactory: IdentityStorageFactory;
  /** Usernames always treated as admins, in addition to `accounts.is_admin`. */
  readonly adminUsernames: readonly string[];
}

/** Builds the `AuthService`, the credential-mode login/session/identity flow for the API. */
export function createAuthService(deps: CreateAuthServiceDeps): AuthService {
  async function isEnvironmentAdmin(identity: {
    providerId: string;
    externalUsername: string;
  }): Promise<boolean> {
    if (
      !deps.adminUsernames.includes(identity.externalUsername) ||
      deps.config.sftpgoUrl === undefined
    )
      return false;
    const resolved = await deps.providers.get(identity.providerId);
    return (
      resolved?.provider.type === "sftpgo" &&
      resolved.provider.baseUrl.replace(/\/+$/, "") === deps.config.sftpgoUrl.replace(/\/+$/, "")
    );
  }

  async function summarize(identity: {
    id: string;
    providerId: string;
    externalUsername: string;
  }): Promise<IdentitySummary> {
    const resolved = await deps.providers.get(identity.providerId);
    if (resolved === null) {
      throw new ApiHttpError("unauthorized", "storage provider no longer exists");
    }
    return {
      id: identity.id,
      username: identity.externalUsername,
      providerId: resolved.provider.id,
      providerType: resolved.module.type as IdentitySummary["providerType"],
      providerLabel: deps.providers.labelFor(resolved.provider),
      capabilities: await deps.providers.capabilitiesFor(resolved),
    };
  }

  async function me(accountId: string, activeIdentityId: string): Promise<MeResponse> {
    const account = await deps.repos.accounts.get(accountId);
    if (!account) {
      throw new ApiHttpError("internal", "account for active session no longer exists");
    }
    const identities = await deps.repos.identities.listByAccount(accountId);
    const activeIdentity = identities.find((identity) => identity.id === activeIdentityId);
    if (activeIdentity === undefined)
      throw new ApiHttpError("unauthorized", "identity ownership changed; sign in again");
    const summaries = await Promise.all(identities.map(summarize));
    const isAdmin = account.isAdmin || (await isEnvironmentAdmin(activeIdentity));

    if ((await deps.repos.identities.get(activeIdentityId))?.accountId !== accountId)
      throw new ApiHttpError("unauthorized", "identity ownership changed; sign in again");
    return {
      account: { id: account.id, displayName: account.displayName },
      identities: summaries,
      activeIdentityId,
      isAdmin,
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
    const result = await accountRepositoryCall(() =>
      deps.identityLinks.loginVerified({
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
      if (verified.token !== undefined) {
        await deps.tokenSource.prime(result.identity.id, verified.token);
      }
    } catch (error) {
      await deps.repos.sessions.delete(idHash);
      throw error;
    }
    const identity = await deps.repos.identities.get(result.identity.id);
    const session = await deps.repos.sessions.getByIdHash(idHash, deps.clock());
    if (
      identity?.accountId !== result.session.accountId ||
      session?.accountId !== result.session.accountId
    ) {
      await deps.repos.sessions.delete(idHash);
      throw new ApiHttpError("unauthorized", "identity ownership changed; sign in again");
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
    // by periodic use. Rotation preserves `createdAt`, so linking or
    // unlinking does not restart this clock.
    if (
      now.getTime() - session.createdAt.getTime() >=
      deps.config.fdriveSessionMaxAgeDays * MS_PER_DAY
    ) {
      await deps.repos.sessions.delete(idHash);
      return null;
    }

    const identityMutation =
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      (c.req.path === "/api/v1/account/active-identity" ||
        c.req.path === "/api/v1/account/identities" ||
        c.req.path.startsWith("/api/v1/account/identities/"));
    if (
      !identityMutation &&
      now.getTime() - session.lastSeenAt.getTime() > SLIDING_TOUCH_THRESHOLD_MS
    ) {
      await deps.repos.sessions.touch(idHash, {
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + deps.config.fdriveSessionTtlDays * MS_PER_DAY),
      });
    }

    const identityHeader = c.req.header(IDENTITY_HEADER);
    const queryIdentities =
      c.req.method === "GET" || c.req.method === "HEAD" ? (c.req.queries("identity") ?? []) : [];
    if (queryIdentities.length > 1)
      throw new ApiHttpError("forbidden", "ambiguous identity selection");
    const queryIdentity = queryIdentities[0];
    if (
      identityHeader !== undefined &&
      queryIdentity !== undefined &&
      identityHeader !== queryIdentity
    )
      throw new ApiHttpError("forbidden", "conflicting identity selection");
    const selectedIdentity = identityHeader ?? queryIdentity;
    if (selectedIdentity !== undefined && !z.uuid().safeParse(selectedIdentity).success)
      throw new ApiHttpError("forbidden", "invalid identity selection");
    const targetIdentityId = selectedIdentity ?? session.activeIdentityId;
    if (targetIdentityId === null) {
      return null;
    }

    const identity = await deps.repos.identities.get(targetIdentityId);
    if (!identity || identity.accountId !== session.accountId) {
      if (selectedIdentity !== undefined) {
        throw new ApiHttpError("forbidden", "identity does not belong to this account");
      }
      return null;
    }

    const account = await deps.repos.accounts.get(session.accountId);
    const isAdmin = (account?.isAdmin ?? false) || (await isEnvironmentAdmin(identity));

    const verifyAuthority = async (): Promise<boolean> => {
      const at = deps.clock();
      const current = await deps.repos.sessions.getByIdHash(idHash, at);
      if (
        !current ||
        at.getTime() - current.createdAt.getTime() >=
          deps.config.fdriveSessionMaxAgeDays * MS_PER_DAY
      ) {
        return false;
      }
      const owned = await deps.repos.identities.get(identity.id);
      return owned !== null && owned.accountId === current.accountId;
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
    login: (input) => accountRepositoryCall(() => loginAt(input, null)),
    loginCandidate: (input, providerId, setupClaimKey) =>
      accountRepositoryCall(() => loginAt(input, providerId, setupClaimKey)),
    resolvePrincipal,
    me,
    logout,
  };
}
