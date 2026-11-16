import { ApiTokenAccess } from "@fdrive/contracts";
import type { ApiTokenRepo, LoginRepo } from "@fdrive/db";
import type { Principal, PrincipalFactory } from "../auth/principal.js";
import { inactiveLogin } from "../auth/service.js";
import { hashApiToken, looksLikeApiToken } from "./token-format.js";

/** A principal an API token authenticated: always with the token's access level and folders. */
export type TokenPrincipal = Principal & { readonly tokenAccess: ApiTokenAccess };

/** `lastUsedAt` is refreshed at most this often, so a busy client does not write on every call. */
const TOUCH_INTERVAL_MS = 60_000;

export interface ResolveTokenPrincipalDeps {
  readonly apiTokens: Pick<ApiTokenRepo, "touch">;
  readonly logins: Pick<LoginRepo, "byToken">;
  readonly clock: () => Date;
  readonly principalFor: PrincipalFactory;
  /** A separate credential audience; defaults to the existing MCP token format. */
  readonly acceptsToken?: (value: string) => boolean;
}

/**
 * Builds `resolveTokenPrincipal(bearer)`: maps a bearer value to the
 * `TokenPrincipal` it authenticates as, the login that created it, or `null`
 * when the value is not a recognizable, live, unexpired fdrive token, or its
 * stored access does not parse. The token and its login are read in one
 * query; a disabled or removed user is refused at once (`forbidden`). Tokens
 * never grant admin access. `lastUsedAt` is touched at most once per
 * `TOUCH_INTERVAL_MS`.
 */
export function createResolveTokenPrincipal(
  deps: ResolveTokenPrincipalDeps,
): (bearer: string) => Promise<TokenPrincipal | null> {
  return async (bearer: string): Promise<TokenPrincipal | null> => {
    if (!(deps.acceptsToken ?? looksLikeApiToken)(bearer)) {
      return null;
    }

    const found = await deps.logins.byToken(hashApiToken(bearer));
    if (found === null) {
      return null;
    }
    const { token, login } = found;
    const access = ApiTokenAccess.safeParse(token.access);
    if (!access.success) return null;

    const now = deps.clock();
    if (token.expiresAt !== null && token.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    if (!login.active) throw inactiveLogin();

    const shouldTouch =
      token.lastUsedAt === null || now.getTime() - token.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS;
    if (shouldTouch) {
      await deps.apiTokens.touch(token.id, now);
    }

    const principal = await deps.principalFor(
      { ...login, isAdmin: false },
      { tokenAccess: access.data },
    );
    return principal as TokenPrincipal;
  };
}
