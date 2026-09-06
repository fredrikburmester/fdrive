import type { Repos } from "@fdrive/db";
import { type SftpgoClient, SftpgoError } from "@fdrive/sftpgo";
import { ApiHttpError } from "../errors.js";
import { open, seal } from "./crypto.js";

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

/** Creates a `TokenSource` backed by `deps.repos` for storage and `deps.sftpgo` for minting. */
export function createTokenSource(deps: CreateTokenSourceDeps): TokenSource {
  const cache = new Map<string, CachedToken>();

  async function mintAndStore(identityId: string): Promise<CachedToken> {
    const identity = await deps.repos.identities.get(identityId);
    if (!identity) {
      throw new ApiHttpError("reauth_required", "identity not found; sign in again");
    }
    const credential = await deps.repos.credentials.get(identityId);
    if (!credential) {
      throw new ApiHttpError("reauth_required", "no stored credentials; sign in again");
    }

    const plaintext = open(deps.master, credential.ciphertext, identityId);
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

    const sealedToken = seal(deps.master, new TextEncoder().encode(minted.accessToken), identityId);
    await deps.repos.credentials.setCachedToken(identityId, {
      sealed: Buffer.from(sealedToken).toString("base64"),
      expiresAt: minted.expiresAt,
    });

    const result: CachedToken = { token: minted.accessToken, expiresAt: minted.expiresAt };
    cache.set(identityId, result);
    return result;
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
      const plaintext = open(deps.master, sealedBytes, identityId);
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
