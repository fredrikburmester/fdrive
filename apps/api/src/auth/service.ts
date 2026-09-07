import { IDENTITY_HEADER, type MeResponse } from "@fdrive/contracts";
import type { Repos } from "@fdrive/db";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { verifyAccountCredentials } from "../accounts/credentials.ts";
import { accountRepositoryCall } from "../accounts/errors.ts";
import type { AccountIdentityOperations } from "../accounts/types.ts";
import type { AppConfig } from "../config.js";
import type { ConnectionStore } from "../connection/store.js";
import { ApiHttpError } from "../errors.js";
import { KEY_ID, seal } from "./crypto.js";
import type { LoginLimiter } from "./login-limiter.js";
import type { Principal } from "./principal.js";
import { type ClientForBaseUrl, requireCurrentConnection } from "./provider-client.ts";
import { COOKIE_NAME, generateSessionId, hashSessionId } from "./sessions.js";
import type { IdentityStorageFactory } from "./storage-factory.ts";
import type { TokenSource } from "./token-source.js";

/** How stale a session's `lastSeenAt` must be before `resolvePrincipal` slides its expiry. */
const SLIDING_TOUCH_THRESHOLD_MS = 5 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface LoginInput {
  readonly username: string;
  readonly password: string;
  readonly otp?: string;
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
  me(accountId: string, activeIdentityId: string): Promise<MeResponse>;
  logout(sessionId: string): Promise<void>;
}

export interface CreateAuthServiceDeps {
  readonly repos: Repos;
  readonly identityLinks: AccountIdentityOperations;
  readonly clientForBaseUrl: ClientForBaseUrl;
  readonly master: Uint8Array;
  readonly clock: () => Date;
  readonly config: AppConfig;
  readonly limiter: LoginLimiter;
  readonly tokenSource: TokenSource;
  readonly storageFactory: IdentityStorageFactory;
  /** Resolves the active SFTPGo connection: its base URL for `providers.ensure` and its label. */
  readonly connectionStore: ConnectionStore;
  /** SFTPGo usernames always treated as admins, in addition to `accounts.is_admin`. */
  readonly adminUsernames: readonly string[];
}

/** The host portion of a SFTPGo base URL, used as `IdentitySummary.providerLabel`. */
function providerLabelFor(baseUrl: string): string {
  return new URL(baseUrl).host;
}

/** Builds the `AuthService`, the credential-mode login/session/identity flow for the API. */
export function createAuthService(deps: CreateAuthServiceDeps): AuthService {
  async function me(accountId: string, activeIdentityId: string): Promise<MeResponse> {
    const account = await deps.repos.accounts.get(accountId);
    if (!account) {
      throw new ApiHttpError("internal", "account for active session no longer exists");
    }
    const identities = await deps.repos.identities.listByAccount(accountId);
    const activeIdentity = identities.find((identity) => identity.id === activeIdentityId);
    if (activeIdentity === undefined)
      throw new ApiHttpError("unauthorized", "identity ownership changed; sign in again");
    const summaries = await Promise.all(
      identities.map(async (identity) => {
        const provider = await deps.repos.providers.get(identity.providerId);
        if (provider === null)
          throw new ApiHttpError("unauthorized", "storage provider no longer exists");
        return {
          id: identity.id,
          username: identity.externalUsername,
          providerType: "sftpgo" as const,
          providerLabel: providerLabelFor(provider.baseUrl),
        };
      }),
    );
    const isAdmin =
      account.isAdmin || deps.adminUsernames.includes(activeIdentity.externalUsername);

    if ((await deps.repos.identities.get(activeIdentityId))?.accountId !== accountId)
      throw new ApiHttpError("unauthorized", "identity ownership changed; sign in again");
    return {
      account: { id: account.id, displayName: account.displayName },
      identities: summaries,
      activeIdentityId,
      isAdmin,
    };
  }

  async function login(input: LoginInput): Promise<LoginResult> {
    const { provider, token } = await verifyAccountCredentials(deps, input);
    const rawSessionId = generateSessionId();
    const idHash = hashSessionId(rawSessionId);
    const at = deps.clock();
    await requireCurrentConnection(deps.connectionStore, provider.baseUrl);
    const result = await accountRepositoryCall(() =>
      deps.identityLinks.loginVerified({
        providerId: provider.id,
        username: input.username,
        at,
        sealCredential: (identityId) => ({
          ciphertext: seal(
            deps.master,
            new TextEncoder().encode(JSON.stringify({ password: input.password })),
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
      await requireCurrentConnection(deps.connectionStore, provider.baseUrl);
      await deps.tokenSource.prime(result.identity.id, token);
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
    const isAdmin =
      (account?.isAdmin ?? false) || deps.adminUsernames.includes(identity.externalUsername);

    return {
      accountId: session.accountId,
      identityId: identity.id,
      username: identity.externalUsername,
      storage: await deps.storageFactory(identity.id),
      isAdmin,
    };
  }

  async function logout(sessionId: string): Promise<void> {
    await deps.repos.sessions.delete(hashSessionId(sessionId));
  }

  return {
    login: (input) => accountRepositoryCall(() => login(input)),
    resolvePrincipal,
    me,
    logout,
  };
}
