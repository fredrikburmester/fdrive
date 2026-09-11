import { createHash, randomBytes } from "node:crypto";

/** Every fdrive API token starts with this prefix, so a leaked value is recognizable at a glance. */
export const TOKEN_PREFIX = "fdr_";

/** Bytes of randomness packed into each generated token (before base64url encoding). */
const TOKEN_RANDOM_BYTES = 32;

/**
 * Characters base64url encodes with, and therefore the only ones a minted
 * token's body can contain: no `+`, `/`, or `=` padding.
 */
const TOKEN_BODY_ALPHABET = "A-Za-z0-9_-";

/**
 * Length of the base64url body `generateApiToken` produces: four characters
 * per three bytes, rounded up, with the padding omitted. Derived rather than
 * written out so the format check can never drift from what is minted.
 */
const TOKEN_BODY_LENGTH = Math.ceil((TOKEN_RANDOM_BYTES * 4) / 3);

/** Total length of a minted token, prefix included. */
export const TOKEN_LENGTH = TOKEN_PREFIX.length + TOKEN_BODY_LENGTH;

const TOKEN_PATTERN = new RegExp(`^${TOKEN_PREFIX}[${TOKEN_BODY_ALPHABET}]{${TOKEN_BODY_LENGTH}}$`);

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

/**
 * True when `value` has exactly the shape `generateApiToken` mints: the
 * `fdr_` prefix followed by `TOKEN_BODY_LENGTH` base64url characters.
 *
 * This is the cheap pre-check that keeps an unauthenticated caller from
 * spending a database round trip: anything that could not possibly be a
 * minted token is rejected here, before it is hashed and looked up. It is
 * therefore exact rather than a prefix sniff: `fdr_x` could never have been
 * issued, so it is not worth a lookup. `TOKEN_RANDOM_BYTES` is part of the
 * accepted wire format for the same reason; changing it invalidates every
 * token already minted.
 */
export function looksLikeApiToken(value: string): boolean {
  return value.length === TOKEN_LENGTH && TOKEN_PATTERN.test(value);
}
