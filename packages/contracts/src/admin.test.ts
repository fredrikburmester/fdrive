import { describe, expect, it } from "vitest";
import {
  AdminConnectionResponse,
  AdminConnectionTestRequest,
  AdminConnectionUpdateRequest,
  ConnectionSource,
} from "./admin";

describe("ConnectionSource", () => {
  it("accepts env and settings", () => {
    expect(ConnectionSource.safeParse("env").success).toBe(true);
    expect(ConnectionSource.safeParse("settings").success).toBe(true);
  });

  it("rejects an unknown source", () => {
    expect(ConnectionSource.safeParse("other").success).toBe(false);
  });
});

describe("AdminConnectionResponse", () => {
  const valid = {
    baseUrl: "http://sftpgo:8080",
    host: "sftpgo:8080",
    homeTemplate: "sftpgo:/{username}",
    source: "env",
    reachable: true,
    checkedAt: "2026-01-01T00:00:00.000Z",
  };

  it("parses a valid payload", () => {
    expect(AdminConnectionResponse.parse(valid)).toEqual(valid);
  });

  it("rejects an invalid source", () => {
    expect(AdminConnectionResponse.safeParse({ ...valid, source: "other" }).success).toBe(false);
  });

  it("rejects a non-datetime checkedAt", () => {
    expect(AdminConnectionResponse.safeParse({ ...valid, checkedAt: "yesterday" }).success).toBe(
      false,
    );
  });
});

describe("AdminConnectionUpdateRequest", () => {
  it("accepts an empty object", () => {
    expect(AdminConnectionUpdateRequest.safeParse({}).success).toBe(true);
  });

  it("accepts baseUrl only", () => {
    expect(AdminConnectionUpdateRequest.safeParse({ baseUrl: "http://sftpgo:8080" }).success).toBe(
      true,
    );
  });

  it("accepts homeTemplate only", () => {
    expect(
      AdminConnectionUpdateRequest.safeParse({ homeTemplate: "sftpgo:/{username}" }).success,
    ).toBe(true);
  });

  it("rejects an invalid baseUrl", () => {
    expect(AdminConnectionUpdateRequest.safeParse({ baseUrl: "nope" }).success).toBe(false);
  });

  it("rejects an empty homeTemplate", () => {
    expect(AdminConnectionUpdateRequest.safeParse({ homeTemplate: "" }).success).toBe(false);
  });
});

describe("AdminConnectionTestRequest", () => {
  it("accepts an empty object", () => {
    expect(AdminConnectionTestRequest.safeParse({}).success).toBe(true);
  });

  it("accepts a baseUrl", () => {
    expect(AdminConnectionTestRequest.safeParse({ baseUrl: "http://sftpgo:8080" }).success).toBe(
      true,
    );
  });

  it("rejects an invalid baseUrl", () => {
    expect(AdminConnectionTestRequest.safeParse({ baseUrl: "nope" }).success).toBe(false);
  });
});
