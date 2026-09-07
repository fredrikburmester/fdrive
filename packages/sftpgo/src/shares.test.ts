import { describe, expect, it } from "vitest";
import { msToDateOrNull, scopeFromWire, scopeToWire, shareInputToWire, toShare } from "./shares.js";
import type { SftpgoShareInput } from "./types.js";

describe("scopeFromWire / scopeToWire", () => {
  it("maps 1 to read and back", () => {
    expect(scopeFromWire(1)).toBe("read");
    expect(scopeToWire("read")).toBe(1);
  });

  it("maps 2 to write and back", () => {
    expect(scopeFromWire(2)).toBe("write");
    expect(scopeToWire("write")).toBe(2);
  });

  it("treats any other wire value as read", () => {
    expect(scopeFromWire(0)).toBe("read");
  });
});

describe("msToDateOrNull", () => {
  it("maps 0 to null", () => {
    expect(msToDateOrNull(0)).toBeNull();
  });

  it("maps a non-zero value to a Date", () => {
    expect(msToDateOrNull(1000)).toEqual(new Date(1000));
  });
});

describe("toShare", () => {
  it("converts a full wire share", () => {
    const share = toShare({
      id: "s1",
      name: "My share",
      description: "desc",
      scope: 2,
      paths: ["/a"],
      username: "alice",
      created_at: 1000,
      updated_at: 2000,
      last_use_at: 3000,
      expires_at: 4000,
      password: "[**redacted**]",
      max_tokens: 5,
      used_tokens: 1,
      allow_from: ["10.0.0.0/8"],
    });
    expect(share).toEqual({
      id: "s1",
      rawScope: 2,
      name: "My share",
      description: "desc",
      scope: "write",
      paths: ["/a"],
      username: "alice",
      createdAt: new Date(1000),
      updatedAt: new Date(2000),
      lastUseAt: new Date(3000),
      expiresAt: new Date(4000),
      maxTokens: 5,
      usedTokens: 1,
      allowFrom: ["10.0.0.0/8"],
      hasPassword: true,
    });
  });

  it("treats zero last_use_at and expires_at as null and defaults missing fields", () => {
    const share = toShare({
      id: "s2",
      name: "n",
      scope: 1,
      paths: [],
      username: "bob",
      created_at: 1,
      updated_at: 1,
      last_use_at: 0,
      expires_at: 0,
      max_tokens: 0,
      used_tokens: 0,
    });
    expect(share.lastUseAt).toBeNull();
    expect(share.expiresAt).toBeNull();
    expect(share.description).toBe("");
    expect(share.allowFrom).toEqual([]);
    expect(share.hasPassword).toBe(false);
  });
});

describe("shareInputToWire", () => {
  const baseInput: SftpgoShareInput = {
    name: "share",
    scope: "read",
    paths: ["/a"],
  };

  it("omits the password field on create when not provided", () => {
    const wire = shareInputToWire(baseInput, false);
    expect(wire.password).toBeUndefined();
  });

  it("sends the redacted marker on update when the password is not provided", () => {
    const wire = shareInputToWire(baseInput, true);
    expect(wire.password).toBe("[**redacted**]");
  });

  it("sends the given password on update when provided", () => {
    const wire = shareInputToWire({ ...baseInput, password: "secret" }, true);
    expect(wire.password).toBe("secret");
  });

  it("sends the given password on create when provided", () => {
    const wire = shareInputToWire({ ...baseInput, password: "secret" }, false);
    expect(wire.password).toBe("secret");
  });

  it("converts a null expiresAt to 0", () => {
    const wire = shareInputToWire({ ...baseInput, expiresAt: null }, false);
    expect(wire.expires_at).toBe(0);
  });

  it("converts a Date expiresAt to milliseconds", () => {
    const date = new Date("2030-01-01T00:00:00Z");
    const wire = shareInputToWire({ ...baseInput, expiresAt: date }, false);
    expect(wire.expires_at).toBe(date.getTime());
  });

  it("defaults optional fields", () => {
    const wire = shareInputToWire(baseInput, false);
    expect(wire).toMatchObject({
      description: "",
      max_tokens: 0,
      allow_from: [],
      expires_at: 0,
      scope: 1,
    });
  });

  it("carries through provided optional fields", () => {
    const wire = shareInputToWire(
      { ...baseInput, description: "d", maxTokens: 3, allowFrom: ["1.2.3.4"] },
      false,
    );
    expect(wire).toMatchObject({ description: "d", max_tokens: 3, allow_from: ["1.2.3.4"] });
  });
});

it("defaults omitted upstream zero values", () => {
  const result = toShare({
    id: "x",
    name: "s",
    scope: 1,
    paths: ["/a"],
    username: "a",
    created_at: 1,
    updated_at: 1,
  });
  expect(result).toMatchObject({ lastUseAt: null, expiresAt: null, maxTokens: 0, usedTokens: 0 });
});
