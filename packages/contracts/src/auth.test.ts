import { describe, expect, it } from "vitest";
import { IdentitySummary, LoginRequest, LoginResponse, MeResponse } from "./auth";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("LoginRequest", () => {
  it("accepts a username and a password", () => {
    expect(LoginRequest.safeParse({ username: "Alice", password: "pw" }).success).toBe(true);
  });

  it("rejects blank or overlong values, a missing field and anything else", () => {
    expect(LoginRequest.safeParse({ username: "", password: "pw" }).success).toBe(false);
    expect(LoginRequest.safeParse({ username: "alice", password: "" }).success).toBe(false);
    expect(LoginRequest.safeParse({ username: "a".repeat(256), password: "pw" }).success).toBe(
      false,
    );
    expect(LoginRequest.safeParse({ username: "alice", password: "x".repeat(1025) }).success).toBe(
      false,
    );
    expect(LoginRequest.safeParse({ username: "alice" }).success).toBe(false);
    expect(
      LoginRequest.safeParse({ username: "alice", password: "pw", otp: "123456" }).success,
    ).toBe(false);
    expect(
      LoginRequest.safeParse({ credential: { username: "alice", password: "pw" } }).success,
    ).toBe(false);
  });
});

describe("IdentitySummary", () => {
  const valid = {
    id: VALID_UUID,
    username: "alice",
  };

  it("parses a valid identity", () => {
    expect(IdentitySummary.parse(valid)).toEqual(valid);
  });

  it("rejects a non-uuid id", () => {
    expect(IdentitySummary.safeParse({ ...valid, id: "not-a-uuid" }).success).toBe(false);
  });

  it("names no storage", () => {
    expect(IdentitySummary.parse({ ...valid, providerId: VALID_UUID })).toEqual(valid);
  });
});

describe("MeResponse", () => {
  const valid = {
    account: { id: VALID_UUID, displayName: "Alice" },
    identity: {
      id: VALID_UUID,
      username: "alice",
    },
    isAdmin: false,
    storageName: "Home",
    index: false,
  };

  it("parses a valid payload", () => {
    expect(MeResponse.parse(valid)).toEqual(valid);
  });

  it("rejects a missing isAdmin, storage name or installation flag", () => {
    for (const key of ["isAdmin", "storageName", "index"] as const) {
      const { [key]: _drop, ...rest } = valid;
      expect(MeResponse.safeParse(rest).success, key).toBe(false);
    }
  });

  it("accepts a null displayName", () => {
    const payload = { ...valid, account: { id: VALID_UUID, displayName: null } };
    expect(MeResponse.safeParse(payload).success).toBe(true);
  });

  it("rejects a missing identity", () => {
    const { identity: _drop, ...rest } = valid;
    expect(MeResponse.safeParse(rest).success).toBe(false);
  });

  it("LoginResponse accepts the same shape as MeResponse", () => {
    expect(LoginResponse.parse(valid)).toEqual(valid);
  });
});
