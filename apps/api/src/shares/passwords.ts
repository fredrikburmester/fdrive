import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * How an owned share's password is stored and checked. A hash is opaque
 * text the share repo keeps beside the row; `version` is a short public
 * fingerprint of it that a credential cookie can carry, so changing or
 * removing the password invalidates every cookie without a counter.
 */
export interface SharePasswords {
  hash(password: string): Promise<string>;
  /** `false` for a wrong password, a missing hash or one this scheme cannot read. */
  verify(password: string, hash: string | null): Promise<boolean>;
  version(hash: string | null): string;
}

export interface ScryptParams {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
}

/** 16 MiB and a few tens of milliseconds per check: Node's own recommendation for a password. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
};
const KEY_BYTES = 32;
const SALT_BYTES = 16;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_BYTES,
      {
        N: params.cost,
        r: params.blockSize,
        p: params.parallelization,
        maxmem: 256 * params.cost * params.blockSize,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function parse(hash: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const [scheme, cost, blockSize, parallelization, salt, key, ...rest] = hash.split("$");
  if (scheme !== "scrypt" || rest.length > 0 || salt === undefined || key === undefined)
    return null;
  const params = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelization: Number(parallelization),
  };
  if (
    !Number.isSafeInteger(params.cost) ||
    params.cost < 2 ||
    !Number.isSafeInteger(params.blockSize) ||
    params.blockSize < 1 ||
    !Number.isSafeInteger(params.parallelization) ||
    params.parallelization < 1
  )
    return null;
  const saltBytes = Buffer.from(salt, "base64url");
  const keyBytes = Buffer.from(key, "base64url");
  if (saltBytes.length === 0 || keyBytes.length !== KEY_BYTES) return null;
  return { params, salt: saltBytes, key: keyBytes };
}

/**
 * scrypt from Node's own `crypto`, so no dependency: `scrypt$N$r$p$salt$key`
 * with base64url parts. The parameters ride with the hash, so they can be
 * raised later without invalidating stored passwords.
 */
export function createScryptSharePasswords(
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): SharePasswords {
  return {
    async hash(password) {
      const salt = randomBytes(SALT_BYTES);
      const key = await derive(password, salt, params);
      return [
        "scrypt",
        params.cost,
        params.blockSize,
        params.parallelization,
        salt.toString("base64url"),
        key.toString("base64url"),
      ].join("$");
    },
    async verify(password, hash) {
      if (hash === null) return false;
      const stored = parse(hash);
      if (stored === null) return false;
      const key = await derive(password, stored.salt, stored.params);
      return timingSafeEqual(key, stored.key);
    },
    version(hash) {
      return hash === null
        ? "open"
        : createHash("sha256").update(hash).digest("base64url").slice(0, 22);
    },
  };
}
