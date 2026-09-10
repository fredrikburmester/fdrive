import type {
  ProviderCredential,
  ProviderModule,
  ProviderToken,
  StorageSession,
} from "@fdrive/core";
import { isStorageError } from "@fdrive/core";
import type { Repos } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";
import type { IdentityProvider, ProviderService } from "../providers/service.js";
import { CryptoError, open, seal } from "./crypto.js";

/**
 * Unseals stored credentials and mints and caches short-lived upstream
 * tokens for identities whose provider module has `mint` (SFTPGo JWTs).
 * Every call resolves the identity's provider row first, so a stored
 * credential is only ever sent to the endpoint it was verified against.
 */
export interface TokenSource {
  /**
   * A currently valid upstream token for `identityId`, minting one if
   * needed; `null` when the identity's provider does not use tokens.
   */
  get(identityId: string): Promise<string | null>;
  /** Forgets any cached token (in-process and in the database) for `identityId`. */
  invalidate(identityId: string): Promise<void>;
  /**
   * Seals and stores `token` for `identityId` (in the database) and fills
   * the in-process cache with it, without minting a new one. Lets a login
   * that already produced a token reuse it here.
   */
  prime(identityId: string, token: ProviderToken): Promise<void>;
  /** The identity's stored credential, unsealed. */
  credential(identityId: string): Promise<ProviderCredential>;
  /** The `StorageSession` a provider module builds storage for `identityId` from. */
  sessionFor(identityId: string, externalUsername: string): StorageSession;
}

export interface CreateTokenSourceDeps {
  readonly repos: Pick<Repos, "credentials">;
  readonly providers: Pick<ProviderService, "forIdentity">;
  readonly master: Uint8Array;
  readonly clock: () => Date;
  readonly fetch: typeof globalThis.fetch;
}

/** A token is re-minted once fewer than this many milliseconds remain before it expires. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

function hasMargin(expiresAt: Date, nowMs: number): boolean {
  return expiresAt.getTime() - nowMs > REFRESH_MARGIN_MS;
}

/**
 * Unseals `blob`, turning a `CryptoError` (for example after a master key
 * rotation makes previously-sealed data unreadable) into
 * `ApiHttpError("reauth_required", ...)` instead of letting it escape as an
 * unhandled 500.
 */
function openOrReauth(master: Uint8Array, blob: Uint8Array, aad: string): Uint8Array {
  try {
    return open(master, blob, aad);
  } catch (err) {
    if (err instanceof CryptoError) {
      throw new ApiHttpError(
        "reauth_required",
        "stored credentials cannot be decrypted; sign in again",
      );
    }
    throw err;
  }
}

/** Parses a sealed credential; anything that is not a JSON object of strings is empty. */
export function parseStoredCredential(bytes: Uint8Array): ProviderCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

/** Creates a `TokenSource` backed by `deps.repos` for storage and provider modules for minting. */
export function createTokenSource(deps: CreateTokenSourceDeps): TokenSource {
  const cache = new Map<string, CachedToken>();

  async function storeAndCache(identityId: string, token: ProviderToken): Promise<void> {
    const sealedToken = seal(deps.master, new TextEncoder().encode(token.token), identityId);
    await deps.repos.credentials.setCachedToken(identityId, {
      sealed: Buffer.from(sealedToken).toString("base64"),
      expiresAt: token.expiresAt,
    });
    cache.set(identityId, { token: token.token, expiresAt: token.expiresAt });
  }

  async function credential(identityId: string): Promise<ProviderCredential> {
    // Resolving the provider first keeps the binding check ahead of any
    // decryption, exactly like `get`.
    await deps.providers.forIdentity(identityId);
    const stored = await deps.repos.credentials.get(identityId);
    if (!stored) {
      throw new ApiHttpError("reauth_required", "no stored credentials; sign in again");
    }
    return parseStoredCredential(openOrReauth(deps.master, stored.ciphertext, identityId));
  }

  async function mintAndStore(
    identityId: string,
    bound: IdentityProvider & { module: ProviderModule & Required<Pick<ProviderModule, "mint">> },
  ): Promise<CachedToken> {
    const { identity, module, instance } = bound;
    const stored = await deps.repos.credentials.get(identityId);
    if (!stored) {
      throw new ApiHttpError("reauth_required", "no stored credentials; sign in again");
    }
    const plaintext = parseStoredCredential(
      openOrReauth(deps.master, stored.ciphertext, identityId),
    );

    let minted: ProviderToken;
    try {
      minted = await module.mint(
        instance,
        { externalUsername: identity.externalUsername, credential: plaintext },
        { fetch: deps.fetch },
      );
    } catch (err) {
      if (isStorageError(err) && (err.kind === "unauthorized" || err.kind === "forbidden")) {
        throw new ApiHttpError(
          "reauth_required",
          "the storage provider rejected the stored credentials; sign in again",
        );
      }
      throw new ApiHttpError("upstream_unavailable", "storage provider is unavailable");
    }

    await storeAndCache(identityId, minted);
    return { token: minted.token, expiresAt: minted.expiresAt };
  }

  async function get(identityId: string): Promise<string | null> {
    // Resolve before cache access, credential decryption, and every retry;
    // the mint below uses this same resolution, never a later one.
    const bound = await deps.providers.forIdentity(identityId);
    const mint = bound.module.mint;
    if (mint === undefined) {
      return null;
    }
    const nowMs = deps.clock().getTime();

    const cached = cache.get(identityId);
    if (cached && hasMargin(cached.expiresAt, nowMs)) {
      return cached.token;
    }

    const stored = await deps.repos.credentials.get(identityId);
    if (
      stored !== null &&
      stored.cachedToken !== null &&
      stored.cachedTokenExpiresAt !== null &&
      hasMargin(stored.cachedTokenExpiresAt, nowMs)
    ) {
      const sealedBytes = new Uint8Array(Buffer.from(stored.cachedToken, "base64"));
      const plaintext = openOrReauth(deps.master, sealedBytes, identityId);
      const token = new TextDecoder().decode(plaintext);
      cache.set(identityId, { token, expiresAt: stored.cachedTokenExpiresAt });
      return token;
    }

    const minted = await mintAndStore(identityId, { ...bound, module: { ...bound.module, mint } });
    return minted.token;
  }

  async function invalidate(identityId: string): Promise<void> {
    cache.delete(identityId);
    await deps.repos.credentials.setCachedToken(identityId, null);
  }

  return {
    get,
    invalidate,
    prime: storeAndCache,
    credential,
    sessionFor(identityId, externalUsername) {
      return {
        externalUsername,
        getCredential: () => credential(identityId),
        getToken: () => get(identityId),
        invalidateToken: () => invalidate(identityId),
      };
    },
  };
}
