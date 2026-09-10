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
  scopeMapping: true,
};

describe("LoginRequest", () => {
  it("accepts a credential without a provider id", () => {
    const result = LoginRequest.safeParse({ credential: { username: "alice", password: "pw" } });
    expect(result.success).toBe(true);
  });

  it("accepts a provider id and any string fields", () => {
    const result = LoginRequest.safeParse({
      providerId: VALID_UUID,
      credential: { username: "alice", password: "hunter2", otp: "123456" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-string field value, an overlong value and unknown top-level keys", () => {
    expect(LoginRequest.safeParse({ credential: { username: 1 } }).success).toBe(false);
    expect(LoginRequest.safeParse({ credential: { password: "x".repeat(4097) } }).success).toBe(
      false,
    );
    expect(LoginRequest.safeParse({ credential: {}, username: "alice" }).success).toBe(false);
    expect(LoginRequest.safeParse({ providerId: "nope", credential: {} }).success).toBe(false);
  });

  it("rejects a missing credential", () => {
    expect(LoginRequest.safeParse({}).success).toBe(false);
  });
});

describe("IdentitySummary", () => {
  const valid = {
    id: VALID_UUID,
    username: "alice",
    providerId: VALID_UUID,
    providerType: "sftpgo",
    providerLabel: "Home SFTPGo",
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
    identities: [
      {
        id: VALID_UUID,
        username: "alice",
        providerId: VALID_UUID,
        providerType: "sftpgo",
        providerLabel: "Home SFTPGo",
        capabilities: CAPABILITIES,
      },
    ],
    activeIdentityId: VALID_UUID,
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
