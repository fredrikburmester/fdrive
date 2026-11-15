import { describe, expect, it } from "vitest";
import { IdentitySummary, LoginRequest, LoginResponse, MeResponse } from "./auth";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";
const CAPABILITIES = {
  zip: true,
  setModifiedAt: true,
  atomicMove: true,
  trash: false,
  shares: true,
  office: true,
  index: true,
  shareWithPeople: false,
};

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
    providerId: VALID_UUID,
    providerType: "local",
    providerLabel: "Local folder",
    capabilities: CAPABILITIES,
  };

  it("parses a valid identity", () => {
    expect(IdentitySummary.parse(valid)).toEqual(valid);
  });

  it("rejects a non-uuid id", () => {
    expect(IdentitySummary.safeParse({ ...valid, id: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects an unknown providerType and missing capabilities", () => {
    expect(IdentitySummary.safeParse({ ...valid, providerType: "gdrive" }).success).toBe(false);
    const { capabilities: _drop, ...rest } = valid;
    expect(IdentitySummary.safeParse(rest).success).toBe(false);
  });
});

describe("MeResponse", () => {
  const valid = {
    account: { id: VALID_UUID, displayName: "Alice" },
    identity: {
      id: VALID_UUID,
      username: "alice",
      providerId: VALID_UUID,
      providerType: "local",
      providerLabel: "Home",
      capabilities: CAPABILITIES,
    },
    isAdmin: false,
  };

  it("parses a valid payload", () => {
    expect(MeResponse.parse(valid)).toEqual(valid);
  });

  it("rejects a missing isAdmin", () => {
    const { isAdmin: _drop, ...rest } = valid;
    expect(MeResponse.safeParse(rest).success).toBe(false);
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
