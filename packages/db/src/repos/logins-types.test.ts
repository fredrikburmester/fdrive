import { describe, expect, it } from "vitest";
import {
  LoginError,
  type LoginVerifiedInput,
  type SealedIdentityCredential,
  validateCanonicalUuid,
  validateLoginVerified,
  validateSealedIdentityCredential,
  validateSessionIdHash,
} from "./logins-types.js";

const id = "00000000-0000-0000-0000-000000000001";
const at = new Date("2026-09-06T12:00:00Z");
const sealed = { ciphertext: new Uint8Array([1]), keyId: "key" };
const login: LoginVerifiedInput = {
  providerId: id,
  username: "alice",
  at,
  sealCredential: () => sealed,
  session: {
    idHash: "a".repeat(64),
    expiresAt: new Date(at.getTime() + 1000),
    userAgent: null,
    ip: null,
  },
};

describe("login validation", () => {
  it("exports errors with stable discriminants", () => {
    const error = new LoginError("setup_claimed");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LoginError");
    expect(error.code).toBe("setup_claimed");
    expect(error.message).toBe("setup_claimed");
  });
  it("accepts strict identifiers, username and metadata boundaries and sealed bytes", () => {
    expect(() => validateCanonicalUuid(id)).not.toThrow();
    expect(() => validateLoginVerified(login)).not.toThrow();
    expect(() => validateLoginVerified({ ...login, username: "é".repeat(255) })).not.toThrow();
    expect(() =>
      validateLoginVerified({
        ...login,
        session: { ...login.session, userAgent: "u".repeat(4096), ip: "i".repeat(255) },
      }),
    ).not.toThrow();
    expect(() => validateSessionIdHash("0".repeat(64))).not.toThrow();
    expect(() => validateSealedIdentityCredential(sealed)).not.toThrow();
    expect(() =>
      validateSealedIdentityCredential({ ...sealed, keyId: "x".repeat(255) }),
    ).not.toThrow();
  });
  it("rejects invalid IDs, timestamps and session hashes", () => {
    for (const bad of ["", "a", id.toUpperCase().replace("1", "A"), "1".repeat(36)]) {
      expect(() => validateCanonicalUuid(bad)).toThrow(TypeError);
    }
    expect(() => validateLoginVerified({ ...login, providerId: "bad" })).toThrow(TypeError);
    expect(() => validateLoginVerified({ ...login, at: new Date(Number.NaN) })).toThrow(TypeError);
    expect(() =>
      validateLoginVerified({ ...login, at: "bad" } as unknown as LoginVerifiedInput),
    ).toThrow(TypeError);
    for (const idHash of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64), "a".repeat(65)]) {
      expect(() => validateSessionIdHash(idHash)).toThrow(TypeError);
      expect(() =>
        validateLoginVerified({ ...login, session: { ...login.session, idHash } }),
      ).toThrow(TypeError);
    }
  });
  it("rejects malformed credentials and usernames before IO", () => {
    for (const username of ["", "x".repeat(256), "bad\0name", 123]) {
      expect(() => validateLoginVerified({ ...login, username } as LoginVerifiedInput)).toThrow(
        TypeError,
      );
    }
    expect(() =>
      validateLoginVerified({ ...login, sealCredential: 1 } as unknown as LoginVerifiedInput),
    ).toThrow(TypeError);
    for (const value of [
      { ...sealed, ciphertext: [] },
      { ...sealed, ciphertext: new Uint8Array() },
      { ...sealed, keyId: 1 },
      { ...sealed, keyId: "" },
      { ...sealed, keyId: "x".repeat(256) },
      { ...sealed, keyId: "key\0" },
    ])
      expect(() => validateSealedIdentityCredential(value as SealedIdentityCredential)).toThrow(
        TypeError,
      );
  });
  it("rejects expiry at or before login, malformed session metadata and revocation flags", () => {
    for (const expiresAt of [at, new Date(at.getTime() - 1), new Date(Number.NaN)]) {
      expect(() =>
        validateLoginVerified({ ...login, session: { ...login.session, expiresAt } }),
      ).toThrow(TypeError);
    }
    for (const userAgent of ["u".repeat(4097), "u\0", 1]) {
      expect(() =>
        validateLoginVerified({
          ...login,
          session: { ...login.session, userAgent },
        } as LoginVerifiedInput),
      ).toThrow(TypeError);
    }
    for (const ip of ["i".repeat(256), "i\0"]) {
      expect(() => validateLoginVerified({ ...login, session: { ...login.session, ip } })).toThrow(
        TypeError,
      );
    }
    expect(() =>
      validateLoginVerified({
        ...login,
        revokeOtherSessions: "yes" as unknown as boolean,
      }),
    ).toThrow(TypeError);
  });
});
