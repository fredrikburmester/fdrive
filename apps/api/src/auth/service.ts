import { IDENTITY_HEADER, type MeResponse } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Repos } from "@fdrive/db";
import { type SftpgoClient, SftpgoError } from "@fdrive/sftpgo";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppConfig } from "../config.js";
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
}

/**
 * The host portion of the SFTPGo base URL, used as `IdentitySummary.providerLabel`.
 * `config.sftpgoUrl` is validated as an http(s) URL when the config loads, so
 * this never needs to fall back to the raw string.
 */
function providerLabelFor(config: Pick<AppConfig, "sftpgoUrl">): string {
  return new URL(config.sftpgoUrl).host;
}

/** Builds the `AuthService`, the credential-mode login/session/identity flow for the API. */
export function createAuthService(deps: CreateAuthServiceDeps): AuthService {
  async function me(accountId: string, activeIdentityId: string): Promise<MeResponse> {
    const account = await deps.repos.accounts.get(accountId);
    if (!account) {
      throw new ApiHttpError("internal", "account for active session no longer exists");
    }
    const identities = await deps.repos.identities.listByAccount(accountId);
    const providerLabel = providerLabelFor(deps.config);

    return {
      account: { id: account.id, displayName: account.displayName },
      identities: identities.map((identity) => ({
        id: identity.id,
        username: identity.externalUsername,
        providerType: "sftpgo" as const,
        providerLabel,
      })),
      activeIdentityId,
    };
  }

  async function login(input: LoginInput): Promise<LoginResult> {
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
    try {
      await deps.sftpgo.login(loginParams);
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
      baseUrl: deps.config.sftpgoUrl,
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

    // Primes the token cache (in-process and sealed in the database) from the
    // credential just stored, so the first authenticated request after login
    // does not need to mint a fresh SFTPGo JWT itself.
    await deps.tokenSource.get(identity.id);

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

    return {
      accountId: session.accountId,
      identityId: identity.id,
      username: identity.externalUsername,
      storage: deps.storageFactory(identity.id),
    };
  }

  async function logout(sessionId: string): Promise<void> {
    await deps.repos.sessions.delete(hashSessionId(sessionId));
  }

  return { login, resolvePrincipal, me, logout };
}
