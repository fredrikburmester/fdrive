import type { ApiTokenAccess } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Login } from "@fdrive/db";
import type { Context, MiddlewareHandler } from "hono";
import { ApiHttpError } from "../errors.js";
import { buildUserStorage, type StorageSource } from "./storage-factory.ts";

/**
 * The authenticated caller of a request: which account and login they act
 * as, read with whatever authenticated the request, plus the storage
 * adapter scoped to that login. Route handlers behind `createRequireAuth`
 * read this from `c.get("principal")`; nothing needs to look the login up
 * again.
 */
export interface Principal {
  readonly accountId: string;
  readonly identityId: string;
  /** The login's username, which names its home folder and its index scopes. */
  readonly username: string;
  /** Built on first use, so a request that touches no files builds none. */
  readonly storage: StorageProvider;
  /** True when this account can reach the System admin routes and pages. */
  readonly isAdmin: boolean;
  /** Present only for tokens with explicit operation and virtual-folder grants. */
  readonly tokenAccess?: ApiTokenAccess;
  /**
   * Re-checks that whatever authenticated this principal (its session) is
   * still valid: the session exists, is unexpired and under its maximum
   * age. Work that outlives the request (a queued job) must call this
   * before touching storage so a logout or a revocation stops it. Absent
   * for principals that cannot go stale beyond the request itself.
   */
  readonly verifyAuthority?: () => Promise<boolean>;
}

/** What a principal adds to its login: a token's grants, a session's recheck. */
export type PrincipalExtras = Pick<Principal, "tokenAccess" | "verifyAuthority">;

/** Builds the principal of an admitted login. */
export type PrincipalFactory = (login: Login, extras?: PrincipalExtras) => Promise<Principal>;

export interface CreatePrincipalFactoryDeps {
  readonly folder: Pick<StorageSource, "storage">;
  readonly clock: () => Date;
}

/**
 * Builds principals for logins a session or token query already read and
 * admitted, so a request reads nothing more to act: the storage is built
 * from the username on first use (`buildUserStorage`). The caller refuses
 * an inactive login before asking.
 */
export function createPrincipalFactory(deps: CreatePrincipalFactoryDeps): PrincipalFactory {
  return async (login, extras) => {
    let storage: StorageProvider | undefined;
    return {
      accountId: login.accountId,
      identityId: login.identityId,
      username: login.username,
      isAdmin: login.isAdmin,
      get storage() {
        storage ??= buildUserStorage(deps.folder, deps.clock, login.username);
        return storage;
      },
      ...extras,
    };
  };
}

/** Hono `Variables` shape for routes mounted behind `createRequireAuth`. */
export type PrincipalVariables = {
  principal: Principal;
};

/**
 * Resolves the `Principal` for a request (from its session cookie, bearer
 * token, etc.), or `null` when the request is not authenticated. Later
 * chunks implement the real session/token lookup; `createApp` defaults to a
 * resolver that always returns `null`.
 */
export type PrincipalResolver = (c: Context) => Promise<Principal | null>;

/**
 * Builds middleware that resolves the caller with `resolve` and sets it as
 * `principal` on the context for downstream handlers. Throws an
 * `ApiHttpError("unauthorized", ...)` when `resolve` returns `null`.
 */
export function createRequireAuth(
  resolve: PrincipalResolver,
): MiddlewareHandler<{ Variables: PrincipalVariables }> {
  return async (c, next) => {
    const principal = await resolve(c);
    if (principal === null) {
      throw new ApiHttpError("unauthorized", "authentication required");
    }
    c.set("principal", principal);
    await next();
  };
}

/**
 * Builds middleware that requires the already-resolved `principal` (must
 * run behind `createRequireAuth`) to be an admin. Throws
 * `ApiHttpError("forbidden", ...)` otherwise.
 */
export function createRequireAdmin(): MiddlewareHandler<{ Variables: PrincipalVariables }> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal.isAdmin) {
      throw new ApiHttpError("forbidden", "admin access required");
    }
    await next();
  };
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_FETCH_SITES = new Set(["same-origin", "none"]);
const REQUESTED_WITH_HEADER = "x-requested-with";
const REQUESTED_WITH_VALUE = "fdrive";

/**
 * Builds CSRF-guard middleware. State-changing requests (POST, PUT, PATCH,
 * DELETE) must satisfy both conditions to proceed:
 *
 * - `sec-fetch-site` is absent, `same-origin`, or `none` (browsers set this
 *   header themselves; it cannot be forged from a cross-site page).
 * - `x-requested-with: fdrive` is present (a simple request cannot set a
 *   custom header without triggering a CORS preflight, which the API's
 *   default same-origin policy would refuse for a cross-site caller).
 *
 * Every other method passes through unchecked.
 */
export function createCsrfGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!STATE_CHANGING_METHODS.has(c.req.method)) {
      await next();
      return;
    }

    const fetchSite = c.req.header("sec-fetch-site");
    const siteIsSafe = fetchSite === undefined || SAFE_FETCH_SITES.has(fetchSite);
    const hasRequestedWithHeader = c.req.header(REQUESTED_WITH_HEADER) === REQUESTED_WITH_VALUE;

    if (!siteIsSafe || !hasRequestedWithHeader) {
      throw new ApiHttpError("forbidden", "cross-site request blocked");
    }

    await next();
  };
}
