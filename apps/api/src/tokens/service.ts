import {
  ApiTokenAccess,
  type ApiTokenSummary,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
} from "@fdrive/contracts";
import { normalizePath } from "@fdrive/core";
import type { ApiTokenRepo } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";
import { generateApiToken, hashApiToken } from "./token-format.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TokenServiceDeps {
  readonly apiTokens: ApiTokenRepo;
  readonly clock: () => Date;
  /** Overrides the random token body; tests pass a fixed generator. */
  readonly generateToken?: () => string;
}

export interface TokenService {
  /** Lists an account's tokens, never their secrets. */
  list(accountId: string): Promise<ApiTokenSummary[]>;
  /**
   * Creates a token that acts as `owner`'s login. Returns the raw secret
   * (shown exactly once) plus its summary.
   */
  create(
    owner: { readonly accountId: string; readonly identityId: string },
    req: CreateApiTokenRequest,
  ): Promise<CreateApiTokenResponse>;
  /** Revokes a token, scoped to the owning account; a no-op for a token that belongs to someone else or does not exist. */
  revoke(id: string, accountId: string): Promise<void>;
}

function toSummary(token: {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  access?: ApiTokenAccess;
}): ApiTokenSummary {
  return {
    id: token.id,
    name: token.name,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    expiresAt: token.expiresAt?.toISOString() ?? null,
    ...(token.access === undefined ? {} : { access: token.access }),
  };
}

/**
 * Builds the account-page token service: list, create (computing the
 * expiry), and revoke. Route handlers only need to parse the request and
 * call these.
 */
export function createTokenService(deps: TokenServiceDeps): TokenService {
  const generateToken = deps.generateToken ?? generateApiToken;

  return {
    async list(accountId) {
      const tokens = await deps.apiTokens.listByAccount(accountId);
      return tokens.map(toSummary);
    },

    async create(owner, req) {
      const expiresAt =
        req.expiresInDays !== undefined
          ? new Date(deps.clock().getTime() + req.expiresInDays * MS_PER_DAY)
          : null;

      const token = generateToken();
      let access: ApiTokenAccess;
      try {
        access = ApiTokenAccess.parse(req.access ?? { mode: "read", paths: ["/"] });
        access.paths = [...new Set(access.paths.map(normalizePath))];
      } catch {
        throw new ApiHttpError("bad_request", "invalid token folder access");
      }
      const created = await deps.apiTokens.create({
        accountId: owner.accountId,
        identityId: owner.identityId,
        name: req.name,
        tokenHash: hashApiToken(token),
        expiresAt,
        access,
      });

      return { token, item: toSummary(created) };
    },

    async revoke(id, accountId) {
      await deps.apiTokens.delete(id, accountId);
    },
  };
}
