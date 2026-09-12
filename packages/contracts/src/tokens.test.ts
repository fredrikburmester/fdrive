import { describe, expect, it } from "vitest";
import {
  ApiTokenExpiresInDays,
  ApiTokenSummary,
  ApiTokensResponse,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
} from "./tokens";

describe("ApiTokenExpiresInDays", () => {
  it("accepts 30, 90, and 365", () => {
    expect(ApiTokenExpiresInDays.safeParse(30).success).toBe(true);
    expect(ApiTokenExpiresInDays.safeParse(90).success).toBe(true);
    expect(ApiTokenExpiresInDays.safeParse(365).success).toBe(true);
  });

  it("rejects any other number", () => {
    expect(ApiTokenExpiresInDays.safeParse(7).success).toBe(false);
  });
});

const VALID_ID = "123e4567-e89b-12d3-a456-426614174000";
const VALID_IDENTITY_ID = "123e4567-e89b-12d3-a456-426614174001";

describe("ApiTokenSummary", () => {
  const valid = {
    id: VALID_ID,
    name: "Claude",
    identityId: VALID_IDENTITY_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  };

  it("parses a valid summary", () => {
    expect(ApiTokenSummary.parse(valid)).toEqual(valid);
  });

  it("allows a null identityId", () => {
    expect(ApiTokenSummary.safeParse({ ...valid, identityId: null }).success).toBe(true);
  });

  it("rejects a non-datetime createdAt", () => {
    expect(ApiTokenSummary.safeParse({ ...valid, createdAt: "yesterday" }).success).toBe(false);
  });
});

describe("ApiTokensResponse", () => {
  it("accepts an empty item list", () => {
    expect(ApiTokensResponse.safeParse({ items: [] }).success).toBe(true);
  });
});

describe("CreateApiTokenRequest", () => {
  it("accepts a name only", () => {
    expect(CreateApiTokenRequest.safeParse({ name: "Claude" }).success).toBe(true);
  });

  it("accepts name, identityId, and expiresInDays", () => {
    expect(
      CreateApiTokenRequest.safeParse({
        name: "Claude",
        identityId: VALID_IDENTITY_ID,
        expiresInDays: 90,
      }).success,
    ).toBe(true);
  });

  it("rejects a non-canonical identityId", () => {
    expect(
      CreateApiTokenRequest.safeParse({
        name: "Claude",
        identityId: VALID_IDENTITY_ID.toUpperCase(),
      }).success,
    ).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(CreateApiTokenRequest.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects an invalid expiresInDays", () => {
    expect(CreateApiTokenRequest.safeParse({ name: "Claude", expiresInDays: 7 }).success).toBe(
      false,
    );
  });
});

describe("CreateApiTokenResponse", () => {
  it("parses a token plus its summary", () => {
    const value = {
      token: "fdr_abc123",
      item: {
        id: VALID_ID,
        name: "Claude",
        identityId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: null,
      },
    };
    expect(CreateApiTokenResponse.parse(value)).toEqual(value);
  });
});

it("validates explicit token modes and bounded absolute folder grants", () => {
  for (const mode of ["read", "organize", "full"]) {
    expect(
      CreateApiTokenRequest.parse({
        name: "Scoped",
        access: { mode, paths: ["/docs", "/Team #1"] },
      }).access?.mode,
    ).toBe(mode);
  }
  for (const access of [
    { mode: "admin", paths: ["/"] },
    { mode: "read", paths: [] },
    { mode: "read", paths: ["relative"] },
    { mode: "read", paths: ["/bad\0name"] },
    { mode: "read", paths: ["/bad\nname"] },
    { mode: "read", paths: ["/bad\u007fname"] },
    { mode: "read", paths: Array(33).fill("/") },
  ])
    expect(CreateApiTokenRequest.safeParse({ name: "Scoped", access }).success).toBe(false);
});
