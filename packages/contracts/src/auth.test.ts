import { describe, expect, it } from "vitest";
import { IdentitySummary, LoginRequest, LoginResponse, MeResponse } from "./auth";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("LoginRequest", () => {
  it("accepts username and password without otp", () => {
    const result = LoginRequest.safeParse({ username: "alice", password: "hunter2" });
    expect(result.success).toBe(true);
  });

  it("accepts an otp", () => {
    const result = LoginRequest.safeParse({
      username: "alice",
      password: "hunter2",
      otp: "123456",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty username", () => {
    expect(LoginRequest.safeParse({ username: "", password: "hunter2" }).success).toBe(false);
  });

  it("rejects a username over 255 characters", () => {
    const result = LoginRequest.safeParse({
      username: "a".repeat(256),
      password: "hunter2",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty password", () => {
    expect(LoginRequest.safeParse({ username: "alice", password: "" }).success).toBe(false);
  });

  it("rejects a missing username", () => {
    expect(LoginRequest.safeParse({ password: "hunter2" }).success).toBe(false);
  });
});

describe("IdentitySummary", () => {
  it("parses a valid identity", () => {
    const payload = {
      id: VALID_UUID,
      username: "alice",
      providerType: "sftpgo",
      providerLabel: "Home SFTPGo",
    };
    expect(IdentitySummary.parse(payload)).toEqual(payload);
  });

  it("rejects a non-uuid id", () => {
    expect(
      IdentitySummary.safeParse({
        id: "not-a-uuid",
        username: "alice",
        providerType: "sftpgo",
        providerLabel: "Home SFTPGo",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown providerType", () => {
    expect(
      IdentitySummary.safeParse({
        id: VALID_UUID,
        username: "alice",
        providerType: "gdrive",
        providerLabel: "Home SFTPGo",
      }).success,
    ).toBe(false);
  });
});

describe("MeResponse", () => {
  const valid = {
    account: { id: VALID_UUID, displayName: "Alice" },
    identities: [
      {
        id: VALID_UUID,
        username: "alice",
        providerType: "sftpgo",
        providerLabel: "Home SFTPGo",
      },
    ],
    activeIdentityId: VALID_UUID,
  };

  it("parses a valid payload", () => {
    expect(MeResponse.parse(valid)).toEqual(valid);
  });

  it("accepts a null displayName", () => {
    const payload = { ...valid, account: { id: VALID_UUID, displayName: null } };
    expect(MeResponse.safeParse(payload).success).toBe(true);
  });

  it("accepts an empty identities array", () => {
    const payload = { ...valid, identities: [] };
    expect(MeResponse.safeParse(payload).success).toBe(true);
  });

  it("rejects a missing activeIdentityId", () => {
    const { activeIdentityId: _drop, ...rest } = valid;
    expect(MeResponse.safeParse(rest).success).toBe(false);
  });

  it("LoginResponse accepts the same shape as MeResponse", () => {
    expect(LoginResponse.parse(valid)).toEqual(valid);
  });
});
