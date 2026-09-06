import { createHash, randomBytes } from "node:crypto";

/** Every fdrive API token starts with this prefix, so a leaked value is recognizable at a glance. */
export const TOKEN_PREFIX = "fdr_";

/** Bytes of randomness packed into each generated token (before base64url encoding). */
const TOKEN_RANDOM_BYTES = 32;

/**
 * Generates a new bearer token: `fdr_` followed by 32 random bytes encoded
 * as base64url. `random` defaults to `crypto.randomBytes`; tests override it
 * for a deterministic value.
 */
export function generateApiToken(
  random: () => Uint8Array = () => randomBytes(TOKEN_RANDOM_BYTES),
): string {
  return `${TOKEN_PREFIX}${Buffer.from(random()).toString("base64url")}`;
}

/** Hashes a token with sha256, hex-encoded, the only form ever stored at rest. */
export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** True when `value` has the shape of an fdrive API token (starts with `fdr_` and carries a body). */
export function looksLikeApiToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length > TOKEN_PREFIX.length;
}
