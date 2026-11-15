import { describe, expect, it } from "vitest";
import {
  LoginError,
  type NewLocalUser,
  type SignInInput,
  validateNewLocalUser,
  validateSessionIdHash,
  validateSignIn,
} from "./logins-types.js";

const at = new Date("2026-09-06T12:00:00Z");
const user: NewLocalUser = {
  username: "alice",
  passwordHash: "scrypt$hash",
  isAdmin: false,
  at,
};
const signIn: SignInInput = {
  username: "alice",
  at,
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
  it("accepts username and metadata boundaries", () => {
    expect(() => validateNewLocalUser(user)).not.toThrow();
    expect(() => validateSignIn(signIn)).not.toThrow();
    expect(() => validateSignIn({ ...signIn, username: "é".repeat(255) })).not.toThrow();
    expect(() =>
      validateSignIn({
        ...signIn,
        session: { ...signIn.session, userAgent: "u".repeat(4096), ip: "i".repeat(255) },
      }),
    ).not.toThrow();
    expect(() => validateSessionIdHash("0".repeat(64))).not.toThrow();
  });
  it("rejects invalid timestamps and session hashes", () => {
    expect(() => validateNewLocalUser({ ...user, at: new Date(Number.NaN) })).toThrow(TypeError);
    expect(() => validateSignIn({ ...signIn, at: "bad" } as unknown as SignInInput)).toThrow(
      TypeError,
    );
    for (const idHash of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64), "a".repeat(65)]) {
      expect(() => validateSessionIdHash(idHash)).toThrow(TypeError);
      expect(() => validateSignIn({ ...signIn, session: { ...signIn.session, idHash } })).toThrow(
        TypeError,
      );
    }
  });
  it("rejects malformed usernames and password hashes before IO", () => {
    for (const username of ["", "x".repeat(256), "bad\0name", 123]) {
      expect(() => validateSignIn({ ...signIn, username } as SignInInput)).toThrow(TypeError);
      expect(() => validateNewLocalUser({ ...user, username } as NewLocalUser)).toThrow(TypeError);
    }
    for (const passwordHash of ["", 1])
      expect(() => validateNewLocalUser({ ...user, passwordHash } as NewLocalUser)).toThrow(
        TypeError,
      );
  });
  it("rejects expiry at or before login and malformed session metadata", () => {
    for (const expiresAt of [at, new Date(at.getTime() - 1), new Date(Number.NaN)]) {
      expect(() =>
        validateSignIn({ ...signIn, session: { ...signIn.session, expiresAt } }),
      ).toThrow(TypeError);
    }
    for (const userAgent of ["u".repeat(4097), "u\0", 1]) {
      expect(() =>
        validateSignIn({
          ...signIn,
          session: { ...signIn.session, userAgent },
        } as SignInInput),
      ).toThrow(TypeError);
    }
    for (const ip of ["i".repeat(256), "i\0"]) {
      expect(() => validateSignIn({ ...signIn, session: { ...signIn.session, ip } })).toThrow(
        TypeError,
      );
    }
  });
});
