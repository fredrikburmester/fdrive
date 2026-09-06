import { IDENTITY_HEADER, type MeResponse } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Repos } from "@fdrive/db";
import { type SftpgoClient, SftpgoError } from "@fdrive/sftpgo";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppConfig } from "../config.js";
import type { ConnectionStore } from "../connection/store.js";
import { ApiHttpError } from "../errors.js";
import { KEY_ID, seal } from "./crypto.js";
import type { LoginLimiter } from "./login-limiter.js";
import type { Principal } from "./principal.js";
import { COOKIE_NAME, generateSessionId, hashSessionId } from "./sessions.js";
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
  readonly sftpgo: SftpgoClient;
  readonly master: Uint8Array;
  readonly clock: () => Date;
  readonly config: AppConfig;
  readonly limiter: LoginLimiter;
  readonly tokenSource: TokenSource;
  readonly storageFactory: (identityId: string) => StorageProvider;
  /** Resolves the active SFTPGo connection: its base URL for `providers.ensure` and its label. */
  readonly connectionStore: ConnectionStore;
  /** SFTPGo usernames always treated as admins, in addition to `accounts.is_admin`. */
  readonly adminUsernames: readonly string[];
}

/** The host portion of a SFTPGo base URL, used as `IdentitySummary.providerLabel`. */
function providerLabelFor(baseUrl: string): string {
  return new URL(baseUrl).host;
}

/** Resolves the active connection, translating "no connection" into `ApiHttpError("setup_required")`. */
async function requireConnection(
  connectionStore: ConnectionStore,
): Promise<{ baseUrl: string; homeTemplate: string }> {
  const connection = await connectionStore.current();
  if (connection === null) {
    throw new ApiHttpError("setup_required", "no SFTPGo connection is configured yet");
  }
  return connection;
}

/** Builds the `AuthService`, the credential-mode login/session/identity flow for the API. */
export function createAuthService(deps: CreateAuthServiceDeps): AuthService {
  async function me(accountId: string, activeIdentityId: string): Promise<MeResponse> {
    const account = await deps.repos.accounts.get(accountId);
    if (!account) {
      throw new ApiHttpError("internal", "account for active session no longer exists");
    }
    const identities = await deps.repos.identities.listByAccount(accountId);
    const connection = await requireConnection(deps.connectionStore);
    const providerLabel = providerLabelFor(connection.baseUrl);
    const activeIdentity = identities.find((identity) => identity.id === activeIdentityId);
    const isAdmin =
      account.isAdmin ||
      (activeIdentity !== undefined &&
        deps.adminUsernames.includes(activeIdentity.externalUsername));

    return {
      account: { id: account.id, displayName: account.displayName },
      identities: identities.map((identity) => ({
        id: identity.id,
        username: identity.externalUsername,
        providerType: "sftpgo" as const,
        providerLabel,
      })),
      activeIdentityId,
      isAdmin,
    };
  }

  async function login(input: LoginInput): Promise<LoginResult> {
    const connection = await requireConnection(deps.connectionStore);

    const limiterKey = `${input.ip}|${input.username}`;
    const limiterStatus = deps.limiter.check(limiterKey);
    if (!limiterStatus.allowed) {
      throw new ApiHttpError("rate_limited", "too many failed login attempts", {
        retryAfterMs: limiterStatus.retryAfterMs ?? 0,
      });
    }

    const loginParams: { username: string; password: string; otp?: string } = {
      username: input.username,
      password: input.password,
      ...(input.otp !== undefined ? { otp: input.otp } : {}),
    };
    let token: { accessToken: string; expiresAt: Date };
    try {
      token = await deps.sftpgo.login(loginParams);
    } catch (err) {
      if (err instanceof SftpgoError) {
        if (err.kind === "unauthorized") {
          deps.limiter.recordFailure(limiterKey);
          throw new ApiHttpError("unauthorized", "invalid username or password");
        }
        if (err.kind === "forbidden") {
          throw new ApiHttpError("forbidden", err.detail ?? "forbidden");
        }
      }
      throw new ApiHttpError("upstream_unavailable", "SFTPGo is unavailable");
    }

    deps.limiter.recordSuccess(limiterKey);

    const provider = await deps.repos.providers.ensure({
      type: "sftpgo",
      baseUrl: connection.baseUrl,
    });

    let identity = await deps.repos.identities.findByProviderUsername(provider.id, input.username);
    let accountId: string;
    if (identity) {
      accountId = identity.accountId;
    } else {
      const account = await deps.repos.accounts.create({ displayName: input.username });
      accountId = account.id;
      identity = await deps.repos.identities.create({
        accountId,
        providerId: provider.id,
        externalUsername: input.username,
      });
    }

    const passwordCiphertext = seal(
      deps.master,
      new TextEncoder().encode(JSON.stringify({ password: input.password })),
      identity.id,
    );
    await deps.repos.credentials.put({
      identityId: identity.id,
      ciphertext: passwordCiphertext,
      keyId: KEY_ID,
    });

    // Primes the token cache (in-process and sealed in the database) from
    // the token this call to sftpgo.login already minted, so the first
    // authenticated request after login reuses it instead of tokenSource.get
    // minting a second, redundant token.
    await deps.tokenSource.prime(identity.id, token);

    await deps.repos.identities.touchLogin(identity.id, deps.clock());

    const rawSessionId = generateSessionId();
    const idHash = hashSessionId(rawSessionId);
    const expiresAt = new Date(
      deps.clock().getTime() + deps.config.fdriveSessionTtlDays * MS_PER_DAY,
    );
    await deps.repos.sessions.create({
      idHash,
      accountId,
      activeIdentityId: identity.id,
      expiresAt,
      userAgent: input.userAgent,
      ip: input.ip,
    });

    return { sessionId: rawSessionId, me: await me(accountId, identity.id) };
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

    if (now.getTime() - session.lastSeenAt.getTime() > SLIDING_TOUCH_THRESHOLD_MS) {
      await deps.repos.sessions.touch(idHash, {
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + deps.config.fdriveSessionTtlDays * MS_PER_DAY),
      });
    }

    const identityHeader = c.req.header(IDENTITY_HEADER);
    const targetIdentityId = identityHeader ?? session.activeIdentityId;
    if (targetIdentityId === null) {
      return null;
    }

    const identity = await deps.repos.identities.get(targetIdentityId);
    if (!identity || identity.accountId !== session.accountId) {
      if (identityHeader !== undefined) {
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
      storage: deps.storageFactory(identity.id),
      isAdmin,
    };
  }

  async function logout(sessionId: string): Promise<void> {
    await deps.repos.sessions.delete(hashSessionId(sessionId));
  }

  return { login, resolvePrincipal, me, logout };
}
