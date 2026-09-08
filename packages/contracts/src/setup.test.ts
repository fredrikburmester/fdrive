import { describe, expect, it } from "vitest";
import {
  ConnectionTestResponse,
  SetupCompleteRequest,
  SetupStatusResponse,
  SetupTestRequest,
  SetupUserInventoryRequest,
  SetupUserInventoryResponse,
} from "./setup";

describe("SetupStatusResponse", () => {
  it("parses a valid payload", () => {
    expect(SetupStatusResponse.parse({ required: true, hasEnvUrl: false })).toEqual({
      required: true,
      hasEnvUrl: false,
    });
  });

  it("rejects a missing field", () => {
    expect(SetupStatusResponse.safeParse({ required: true }).success).toBe(false);
  });
});

describe("Setup user inventory contracts", () => {
  it("bounds pagination and only exposes username/status", () => {
    expect(
      SetupUserInventoryRequest.parse({ username: "admin", password: "secret" }),
    ).toMatchObject({
      limit: 50,
      offset: 0,
    });
    expect(
      SetupUserInventoryResponse.parse({
        ok: true,
        users: [{ username: "alice", status: "enabled" }],
        nextOffset: null,
      }),
    ).toEqual({ ok: true, users: [{ username: "alice", status: "enabled" }], nextOffset: null });
  });

  it("rejects unbounded pagination and raw upstream fields", () => {
    expect(
      SetupUserInventoryRequest.safeParse({ username: "admin", password: "x", limit: 101 }).success,
    ).toBe(false);
    expect(
      SetupUserInventoryResponse.safeParse({
        ok: true,
        users: [{ username: "a", home_dir: "/secret" }],
      }).success,
    ).toBe(false);
  });
});

describe("SetupTestRequest", () => {
  it("accepts a valid http(s) baseUrl", () => {
    expect(SetupTestRequest.safeParse({ baseUrl: "http://sftpgo:8080" }).success).toBe(true);
  });

  it("rejects a non-http(s) baseUrl", () => {
    expect(SetupTestRequest.safeParse({ baseUrl: "not-a-url" }).success).toBe(false);
  });
});

describe("ConnectionTestResponse", () => {
  it("parses a valid payload", () => {
    expect(ConnectionTestResponse.parse({ ok: true, detail: "reachable" })).toEqual({
      ok: true,
      detail: "reachable",
    });
  });

  it("rejects a missing detail", () => {
    expect(ConnectionTestResponse.safeParse({ ok: true }).success).toBe(false);
  });
});

describe("SetupCompleteRequest", () => {
  const valid = {
    baseUrl: "http://sftpgo:8080",
    homeTemplate: "sftpgo:/{username}",
    username: "alice",
    password: "hunter2",
  };

  it("accepts a valid payload without otp", () => {
    expect(SetupCompleteRequest.safeParse(valid).success).toBe(true);
  });

  it("accepts an otp", () => {
    expect(SetupCompleteRequest.safeParse({ ...valid, otp: "123456" }).success).toBe(true);
  });

  it("rejects an empty homeTemplate", () => {
    expect(SetupCompleteRequest.safeParse({ ...valid, homeTemplate: "" }).success).toBe(false);
  });

  it("rejects an empty username", () => {
    expect(SetupCompleteRequest.safeParse({ ...valid, username: "" }).success).toBe(false);
  });

  it("rejects an empty password", () => {
    expect(SetupCompleteRequest.safeParse({ ...valid, password: "" }).success).toBe(false);
  });
});
