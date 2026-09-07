import { describe, expect, it } from "vitest";
import {
  IdentityLinksError,
  type LinkVerifiedInput,
  type LoginVerifiedInput,
  type SealedIdentityCredential,
  type SwitchActiveIdentityInput,
  validateIdentityLinkId,
  validateLinkVerified,
  validateLoginVerified,
  validateRotateSession,
  validateSealedIdentityCredential,
  validateSessionIdHash,
  validateSwitchActiveIdentity,
  validateUnlinkIdentity,
} from "./identity-links-types.js";

const id = "00000000-0000-0000-0000-000000000001";
const at = new Date("2026-09-06T12:00:00Z");
const sealed = { ciphertext: new Uint8Array([1]), keyId: "key" };
const link = { accountId: id, providerId: id, username: "alice", at, sealCredential: () => sealed };
const unlink = { accountId: id, identityId: id, at };
const active = { ...unlink, sessionIdHash: "a".repeat(64) };

describe("identity link validation", () => {
  it("exports errors with stable discriminants", () => {
    const error = new IdentityLinksError("forbidden");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("IdentityLinksError");
    expect(error.code).toBe("forbidden");
    expect(error.message).toBe("forbidden");
  });
  it("accepts strict identifiers, username boundaries and sealed bytes", () => {
    expect(() => validateIdentityLinkId(id)).not.toThrow();
    expect(() => validateLinkVerified(link)).not.toThrow();
    expect(() => validateLinkVerified({ ...link, username: "é".repeat(255) })).not.toThrow();
    expect(() => validateUnlinkIdentity(unlink)).not.toThrow();
    expect(() => validateSwitchActiveIdentity(active)).not.toThrow();
    expect(() => validateSealedIdentityCredential(sealed)).not.toThrow();
    expect(() =>
      validateSealedIdentityCredential({ ...sealed, keyId: "x".repeat(255) }),
    ).not.toThrow();
  });
  it("rejects invalid IDs, timestamps and session hashes", () => {
    for (const bad of ["", "a", id.toUpperCase().replace("1", "A"), "1".repeat(36)]) {
      expect(() => validateIdentityLinkId(bad)).toThrow(TypeError);
    }
    expect(() => validateLinkVerified({ ...link, accountId: "bad" })).toThrow(TypeError);
    expect(() => validateLinkVerified({ ...link, providerId: "bad" })).toThrow(TypeError);
    expect(() => validateUnlinkIdentity({ ...unlink, identityId: "bad" })).toThrow(TypeError);
    expect(() => validateLinkVerified({ ...link, at: new Date(Number.NaN) })).toThrow(TypeError);
    expect(() =>
      validateLinkVerified({ ...link, at: "bad" } as unknown as LinkVerifiedInput),
    ).toThrow(TypeError);
    for (const sessionIdHash of [
      "",
      "A".repeat(64),
      "a".repeat(63),
      "g".repeat(64),
      "a".repeat(65),
    ]) {
      expect(() => validateSwitchActiveIdentity({ ...active, sessionIdHash })).toThrow(TypeError);
    }
    expect(() =>
      validateSwitchActiveIdentity({ ...active, accountId: "bad" } as SwitchActiveIdentityInput),
    ).toThrow(TypeError);
  });
  it("rejects malformed credentials and usernames before IO", () => {
    for (const username of ["", "x".repeat(256), "bad\0name", 123]) {
      expect(() => validateLinkVerified({ ...link, username } as LinkVerifiedInput)).toThrow(
        TypeError,
      );
    }
    expect(() =>
      validateLinkVerified({ ...link, sealCredential: 1 } as unknown as LinkVerifiedInput),
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
});

describe("atomic login and rotation validation", () => {
  const login = {
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
  const rotation = {
    accountId: id,
    activeIdentityId: id,
    oldSessionIdHash: "a".repeat(64),
    newSessionIdHash: "b".repeat(64),
    at,
  };
  it("accepts valid sessions, metadata boundaries and optional requesting hashes", () => {
    expect(() => validateLoginVerified(login)).not.toThrow();
    expect(() =>
      validateLoginVerified({
        ...login,
        session: { ...login.session, userAgent: "u".repeat(4096), ip: "i".repeat(255) },
      }),
    ).not.toThrow();
    expect(() => validateRotateSession(rotation)).not.toThrow();
    expect(() => validateSessionIdHash("0".repeat(64))).not.toThrow();
    expect(() =>
      validateLinkVerified({ ...link, requestingSessionIdHash: "a".repeat(64) }),
    ).not.toThrow();
    expect(() =>
      validateUnlinkIdentity({ ...unlink, requestingSessionIdHash: "a".repeat(64) }),
    ).not.toThrow();
  });
  it("rejects expiry at or before login and malformed session metadata", () => {
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
      validateLoginVerified({ ...login, session: { ...login.session, idHash: "bad" } }),
    ).toThrow(TypeError);
  });
  it("rejects malformed or unchanged rotation hashes and requesting hashes", () => {
    expect(() => validateRotateSession({ ...rotation, activeIdentityId: "bad" })).toThrow(
      TypeError,
    );
    expect(() => validateRotateSession({ ...rotation, oldSessionIdHash: "bad" })).toThrow(
      TypeError,
    );
    expect(() => validateRotateSession({ ...rotation, newSessionIdHash: "bad" })).toThrow(
      TypeError,
    );
    expect(() =>
      validateRotateSession({ ...rotation, newSessionIdHash: rotation.oldSessionIdHash }),
    ).toThrow(TypeError);
    expect(() => validateLinkVerified({ ...link, requestingSessionIdHash: "bad" })).toThrow(
      TypeError,
    );
    expect(() => validateUnlinkIdentity({ ...unlink, requestingSessionIdHash: "bad" })).toThrow(
      TypeError,
    );
  });
});
