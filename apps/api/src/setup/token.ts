import { randomBytes, timingSafeEqual } from "node:crypto";

/** Generates a fresh setup token: 32 random bytes, base64url-encoded. */
export function generateSetupToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Compares two strings for equality without leaking timing information
 * about where they first differ. Safe to use even when the two strings
 * have different lengths (returns false immediately, still without
 * branching on the *content* of either string).
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Guards the one-time setup token: holds the active token, verifies a
 * candidate against it, and can be invalidated once setup completes so a
 * captured token cannot be replayed.
 */
export interface SetupTokenGuard {
  readonly token: string;
  verify(candidate: string | undefined): boolean;
  invalidate(): void;
}

/** Builds a `SetupTokenGuard` around `token`. */
export function createSetupTokenGuard(token: string): SetupTokenGuard {
  let active = true;
  return {
    token,
    verify(candidate) {
      if (!active || candidate === undefined) {
        return false;
      }
      return timingSafeEqualStrings(candidate, token);
    },
    invalidate() {
      active = false;
    },
  };
}
