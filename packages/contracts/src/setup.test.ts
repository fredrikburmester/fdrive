import { describe, expect, it } from "vitest";
import { SetupCompleteRequest, SetupStatusResponse } from "./setup";

describe("SetupStatusResponse", () => {
  it("parses whether setup is required and whether the deployment has a files folder", () => {
    for (const status of [
      { required: true, storageConfigured: true },
      { required: true, storageConfigured: false },
      { required: false, storageConfigured: true },
    ]) {
      expect(SetupStatusResponse.parse(status)).toEqual(status);
    }
  });

  it("rejects a missing field", () => {
    expect(SetupStatusResponse.safeParse({ required: true }).success).toBe(false);
    expect(SetupStatusResponse.safeParse({ storageConfigured: true }).success).toBe(false);
  });
});

describe("SetupCompleteRequest", () => {
  const valid = { username: "alice", password: "correct-horse" };

  it("accepts a username and password", () => {
    expect(SetupCompleteRequest.parse(valid)).toEqual(valid);
  });

  it("trims the username", () => {
    expect(SetupCompleteRequest.parse({ ...valid, username: "  alice  " })).toEqual(valid);
  });

  it("rejects usernames that cannot be a home folder", () => {
    for (const username of ["", ".alice", "a/b", "a b", "x".repeat(256)]) {
      expect(SetupCompleteRequest.safeParse({ ...valid, username }).success).toBe(false);
    }
  });

  it("rejects a password that is too short or too long", () => {
    expect(SetupCompleteRequest.safeParse({ ...valid, password: "short" }).success).toBe(false);
    expect(SetupCompleteRequest.safeParse({ ...valid, password: "x".repeat(1025) }).success).toBe(
      false,
    );
  });

  it("rejects the fields of the removed provider setup", () => {
    expect(SetupCompleteRequest.safeParse({ ...valid, kind: "local" }).success).toBe(false);
    expect(SetupCompleteRequest.safeParse({ ...valid, baseUrl: "http://a" }).success).toBe(false);
  });
});
