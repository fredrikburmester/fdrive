import type { ApiTokenRepo, IdentityRepo } from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import type { IdentityStorageFactory } from "../auth/storage-factory.ts";
import { hashApiToken, looksLikeApiToken } from "./token-format.js";

/** `lastUsedAt` is refreshed at most this often, so a busy client does not write on every call. */
const TOUCH_INTERVAL_MS = 60_000;

export interface ResolveTokenPrincipalDeps {
  readonly apiTokens: ApiTokenRepo;
  readonly identities: IdentityRepo;
  readonly clock: () => Date;
  readonly storageFactory: IdentityStorageFactory;
}

/**
 * Builds `resolveTokenPrincipal(bearer)`: maps a bearer value to the
 * `Principal` it authenticates as, or `null` when the value is not a
 * recognizable, live, unexpired fdrive token, or its identity has since been
 * unlinked. Tokens never grant admin access. `lastUsedAt` is touched at most
 * once per `TOUCH_INTERVAL_MS`.
 */
export function createResolveTokenPrincipal(
  deps: ResolveTokenPrincipalDeps,
): (bearer: string) => Promise<Principal | null> {
  return async (bearer: string): Promise<Principal | null> => {
    if (!looksLikeApiToken(bearer)) {
      return null;
    }

    const token = await deps.apiTokens.findByHash(hashApiToken(bearer));
    if (token === null) {
      return null;
    }

    const now = deps.clock();
    if (token.expiresAt !== null && token.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    if (token.identityId === null) {
      return null;
    }

    const identity = await deps.identities.get(token.identityId);
    if (!identity || identity.accountId !== token.accountId) {
      return null;
    }

    const shouldTouch =
      token.lastUsedAt === null || now.getTime() - token.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS;
    if (shouldTouch) {
      await deps.apiTokens.touch(token.id, now);
    }

    return {
      accountId: token.accountId,
      identityId: identity.id,
      username: identity.externalUsername,
      storage: await deps.storageFactory(identity.id),
      isAdmin: false,
    };
  };
}
