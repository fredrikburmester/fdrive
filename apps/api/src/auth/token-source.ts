import type { Repos } from "@fdrive/db";
import { type SftpgoClient, SftpgoError } from "@fdrive/sftpgo";
import { ApiHttpError } from "../errors.js";
import { CryptoError, open, seal } from "./crypto.js";

/** Re-mints and caches SFTPGo JWTs for identities, unsealing stored passwords on demand. */
export interface TokenSource {
  /** Returns a currently-valid SFTPGo JWT for `identityId`, minting one if needed. */
  get(identityId: string): Promise<string>;
  /** Forgets any cached token (in-process and in the database) for `identityId`. */
  invalidate(identityId: string): Promise<void>;
  /**
   * Runs `fn` with a valid token. If `fn` rejects with a `SftpgoError` of
   * kind `unauthorized`, invalidates the cached token, mints a fresh one,
   * and retries `fn` exactly once.
   */
  withToken<T>(identityId: string, fn: (token: string) => Promise<T>): Promise<T>;
  /**
   * Seals and stores `token` for `identityId` (in the database) and fills
   * the in-process cache with it, without minting a new one. Lets a caller
   * that already has a fresh token from its own `sftpgo.login` call (for
   * example the login flow) reuse it here instead of `get` minting a
   * second, redundant token.
   */
  prime(identityId: string, token: { accessToken: string; expiresAt: Date }): Promise<void>;
}

export interface CreateTokenSourceDeps {
  readonly repos: Repos;
  readonly sftpgo: SftpgoClient;
  readonly master: Uint8Array;
  readonly clock: () => Date;
}

/** A token is re-minted once fewer than this many milliseconds remain before it expires. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

interface StoredPassword {
  readonly password: string;
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

/** Creates a `TokenSource` backed by `deps.repos` for storage and `deps.sftpgo` for minting. */
export function createTokenSource(deps: CreateTokenSourceDeps): TokenSource {
  const cache = new Map<string, CachedToken>();

  async function storeAndCache(
    identityId: string,
    token: { accessToken: string; expiresAt: Date },
  ): Promise<void> {
    const sealedToken = seal(deps.master, new TextEncoder().encode(token.accessToken), identityId);
    await deps.repos.credentials.setCachedToken(identityId, {
      sealed: Buffer.from(sealedToken).toString("base64"),
      expiresAt: token.expiresAt,
    });
    cache.set(identityId, { token: token.accessToken, expiresAt: token.expiresAt });
  }

  async function mintAndStore(identityId: string): Promise<CachedToken> {
    const identity = await deps.repos.identities.get(identityId);
    if (!identity) {
      throw new ApiHttpError("reauth_required", "identity not found; sign in again");
    }
    const credential = await deps.repos.credentials.get(identityId);
    if (!credential) {
      throw new ApiHttpError("reauth_required", "no stored credentials; sign in again");
    }

    const plaintext = openOrReauth(deps.master, credential.ciphertext, identityId);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as StoredPassword;

    let minted: { accessToken: string; expiresAt: Date };
    try {
      minted = await deps.sftpgo.login({
        username: identity.externalUsername,
        password: parsed.password,
      });
    } catch (err) {
      if (err instanceof SftpgoError && err.kind === "unauthorized") {
        throw new ApiHttpError(
          "reauth_required",
          "SFTPGo rejected the stored credentials; sign in again",
        );
      }
      throw new ApiHttpError("upstream_unavailable", "SFTPGo is unavailable");
    }

    await storeAndCache(identityId, minted);
    return { token: minted.accessToken, expiresAt: minted.expiresAt };
  }

  async function get(identityId: string): Promise<string> {
    const nowMs = deps.clock().getTime();

    const cached = cache.get(identityId);
    if (cached && hasMargin(cached.expiresAt, nowMs)) {
      return cached.token;
    }

    const credential = await deps.repos.credentials.get(identityId);
    if (
      credential !== null &&
      credential.cachedToken !== null &&
      credential.cachedTokenExpiresAt !== null &&
      hasMargin(credential.cachedTokenExpiresAt, nowMs)
    ) {
      const sealedBytes = new Uint8Array(Buffer.from(credential.cachedToken, "base64"));
      const plaintext = openOrReauth(deps.master, sealedBytes, identityId);
      const token = new TextDecoder().decode(plaintext);
      cache.set(identityId, { token, expiresAt: credential.cachedTokenExpiresAt });
      return token;
    }

    const minted = await mintAndStore(identityId);
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
    async withToken<T>(identityId: string, fn: (token: string) => Promise<T>): Promise<T> {
      const token = await get(identityId);
      try {
        return await fn(token);
      } catch (err) {
        if (err instanceof SftpgoError && err.kind === "unauthorized") {
          await invalidate(identityId);
          const fresh = await get(identityId);
          return await fn(fresh);
        }
        throw err;
      }
    },
  };
}
