import type { MeResponse } from "@fdrive/contracts";
import { LoginError, type Repos } from "@fdrive/db";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import type { CheckPassword } from "./password.ts";
import type { Principal, PrincipalFactory } from "./principal.js";
import { COOKIE_NAME, generateSessionId, hashSessionId } from "./sessions.js";

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
  me(identityId: string): Promise<MeResponse>;
  logout(sessionId: string): Promise<void>;
}

/** What `/auth/me` reports about the whole installation, the same for every login. */
export type Installation = Pick<MeResponse, "storageName" | "index" | "encryptedFolders">;

export interface CreateAuthServiceDeps {
  readonly repos: Repos;
  readonly clock: () => Date;
  readonly config: AppConfig;
  readonly checkPassword: CheckPassword;
  /** Builds the principal of a session's login once it is admitted. */
  readonly principalFor: PrincipalFactory;
  /** Read for every `/auth/me`, so a new name applies at once. */
  readonly installation: () => Promise<Installation>;
}

/** The refusal for a disabled or removed user: signing in again would not help. */
export function inactiveLogin(): ApiHttpError {
  return new ApiHttpError("forbidden", "this user may not sign in");
}

/** Builds the `AuthService`, the API's sign-in and session flow. */
export function createAuthService(deps: CreateAuthServiceDeps): AuthService {
  async function me(identityId: string): Promise<MeResponse> {
    const login = await deps.repos.logins.get(identityId);
    if (login === null) throw new ApiHttpError("unauthorized", "sign in again");
    return {
      account: { id: login.accountId, displayName: login.displayName },
      identity: { id: login.identityId, username: login.username },
      isAdmin: login.isAdmin,
      ...(await deps.installation()),
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
      return { sessionId: rawSessionId, me: await me(identity.id) };
    } catch (error) {
      await deps.repos.sessions.delete(idHash);
      throw error;
    }
  }

  /**
   * The session cookie's principal, in one query: the live session, its
   * login and account, and whether its user is still active. A disabled or
   * removed user is refused at once (`forbidden`), not at their next
   * sign-in. Sliding the expiry writes at most once every five minutes.
   */
  async function resolvePrincipal(c: Context): Promise<Principal | null> {
    const rawSessionId = getCookie(c, COOKIE_NAME);
    if (rawSessionId === undefined) {
      return null;
    }

    const idHash = hashSessionId(rawSessionId);
    const now = deps.clock();
    const found = await deps.repos.logins.bySession(idHash, now);
    if (found === null) {
      return null;
    }
    const { session, login } = found;
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
    if (!login.active) throw inactiveLogin();

    if (now.getTime() - session.lastSeenAt.getTime() > SLIDING_TOUCH_THRESHOLD_MS) {
      await deps.repos.sessions.touch(idHash, {
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + deps.config.fdriveSessionTtlDays * MS_PER_DAY),
      });
    }

    const verifyAuthority = async (): Promise<boolean> => {
      const at = deps.clock();
      const current = await deps.repos.sessions.getByIdHash(idHash, at);
      return (
        current !== null &&
        at.getTime() - current.createdAt.getTime() <
          deps.config.fdriveSessionMaxAgeDays * MS_PER_DAY
      );
    };

    // A files folder fdrive may not use leaves the session working: every
    // storage operation fails with `upstream_unavailable` instead.
    return deps.principalFor(login, { verifyAuthority });
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
