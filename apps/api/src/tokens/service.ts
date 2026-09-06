import type {
  ApiTokenSummary,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
} from "@fdrive/contracts";
import type { ApiTokenRepo, IdentityRepo } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";
import { generateApiToken, hashApiToken } from "./token-format.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TokenServiceDeps {
  readonly apiTokens: ApiTokenRepo;
  readonly identities: IdentityRepo;
  readonly clock: () => Date;
  /** Overrides the random token body; tests pass a fixed generator. */
  readonly generateToken?: () => string;
}

export interface TokenService {
  /** Lists an account's tokens, never their secrets. */
  list(accountId: string): Promise<ApiTokenSummary[]>;
  /**
   * Creates a token for `accountId`, defaulting `identityId` to the
   * account's first linked identity when omitted. Returns the raw secret
   * (shown exactly once) plus its summary. Throws `bad_request` when
   * `identityId` is given but does not belong to the account, or when the
   * account has no identity to fall back to.
   */
  create(accountId: string, req: CreateApiTokenRequest): Promise<CreateApiTokenResponse>;
  /** Revokes a token, scoped to the owning account; a no-op for a token that belongs to someone else or does not exist. */
  revoke(id: string, accountId: string): Promise<void>;
}

function toSummary(token: {
  id: string;
  name: string;
  identityId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}): ApiTokenSummary {
  return {
    id: token.id,
    name: token.name,
    identityId: token.identityId,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    expiresAt: token.expiresAt?.toISOString() ?? null,
  };
}

/**
 * Builds the account-page token service: list, create (defaulting the
 * identity and computing the expiry), and revoke. Route handlers only need
 * to parse the request and call these.
 */
export function createTokenService(deps: TokenServiceDeps): TokenService {
  const generateToken = deps.generateToken ?? generateApiToken;

  return {
    async list(accountId) {
      const tokens = await deps.apiTokens.listByAccount(accountId);
      return tokens.map(toSummary);
    },

    async create(accountId, req) {
      let identityId = req.identityId;
      if (identityId !== undefined) {
        const identity = await deps.identities.get(identityId);
        if (!identity || identity.accountId !== accountId) {
          throw new ApiHttpError("bad_request", "identityId does not belong to this account");
        }
      } else {
        const identities = await deps.identities.listByAccount(accountId);
        const first = identities[0];
        if (first === undefined) {
          throw new ApiHttpError(
            "bad_request",
            "account has no linked identity to scope a token to",
          );
        }
        identityId = first.id;
      }

      const expiresAt =
        req.expiresInDays !== undefined
          ? new Date(deps.clock().getTime() + req.expiresInDays * MS_PER_DAY)
          : null;

      const token = generateToken();
      const created = await deps.apiTokens.create({
        accountId,
        identityId,
        name: req.name,
        tokenHash: hashApiToken(token),
        expiresAt,
      });

      return { token, item: toSummary(created) };
    },

    async revoke(id, accountId) {
      await deps.apiTokens.delete(id, accountId);
    },
  };
}
