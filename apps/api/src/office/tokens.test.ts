import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOfficeTokenCodec } from "./tokens.ts";

const master = Buffer.alloc(32, 7);
const codec = createOfficeTokenCodec(master);
const now = new Date("2026-09-06T00:00:00Z");
const input = {
  fileId: "123e4567-e89b-42d3-a456-426614174000",
  identityId: "123e4567-e89b-42d3-a456-426614174001",
  sessionHash: "ab".repeat(32),
  mode: "edit" as const,
  now,
  sessionExpiresAt: new Date(now.getTime() + 24 * 3600000),
};
function customToken(patch: Record<string, unknown>, header = '{"alg":"HS256","typ":"JWT"}') {
  const valid = codec.verify(codec.mint(input).token, now);
  const body = `${Buffer.from(header).toString("base64url")}.${Buffer.from(JSON.stringify({ ...valid, ...patch })).toString("base64url")}`;
  const key = Buffer.from(
    hkdfSync("sha256", master, "fdrive:office:v1", "fdrive:wopi:access-token", 32),
  );
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
describe("office tokens", () => {
  it("binds identity, file, session hash and edit intent with eight-hour expiry", () => {
    const minted = codec.mint(input);
    expect(minted.expiresAt.getTime() - now.getTime()).toBe(8 * 3600000);
    expect(codec.verify(minted.token, now)).toMatchObject({
      sub: input.fileId,
      identityId: input.identityId,
      sessionHash: input.sessionHash,
      mode: "edit",
      aud: "fdrive:wopi",
      iss: "fdrive",
    });
  });
  it("caps expiry at the browser session and supports view", () => {
    const expiry = new Date(now.getTime() + 10000);
    const minted = codec.mint({ ...input, mode: "view", sessionExpiresAt: expiry });
    expect(minted.expiresAt).toEqual(expiry);
    expect(codec.verify(minted.token, expiry)).toBeNull();
    expect(codec.verify(minted.token, new Date(expiry.getTime() - 1))?.mode).toBe("view");
  });
  it("rejects expired issuance and wrong master size", () => {
    expect(() => codec.mint({ ...input, sessionExpiresAt: now })).toThrow();
    expect(() => createOfficeTokenCodec(Buffer.alloc(31))).toThrow();
  });
  it.each(["", "a".repeat(4097), "a.b.c", `eyJhbGciOiJub25lIn0.e30.${"a".repeat(43)}`])(
    "rejects malformed input",
    (token) => expect(codec.verify(token, now)).toBeNull(),
  );
  it.each([
    { aud: "other" },
    { iss: "other" },
    { mode: "admin" },
    { sub: "bad" },
    { sessionHash: "raw-cookie" },
    { extra: "claim" },
    { iat: now.getTime() / 1000 + 1 },
    { exp: now.getTime() / 1000 },
    { exp: now.getTime() / 1000 + 8 * 3600 + 1 },
    { iat: 0, exp: 1 },
  ])("rejects invalid signed claims", (patch) =>
    expect(codec.verify(customToken(patch), now)).toBeNull(),
  );
  it("rejects algorithms, future verification time and noncanonical signature", () => {
    expect(codec.verify(customToken({}, '{"alg":"none","typ":"JWT"}'), now)).toBeNull();
    expect(codec.verify(codec.mint(input).token, new Date(NaN))).toBeNull();
    const token = codec.mint(input).token;
    expect(codec.verify(`${token.slice(0, -1)}_`, now)).toBeNull();
    expect(createOfficeTokenCodec(Buffer.alloc(32, 8)).verify(token, now)).toBeNull();
  });
});
