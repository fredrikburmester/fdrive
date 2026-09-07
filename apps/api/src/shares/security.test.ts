import { hkdfSync } from "node:crypto";
import { expect, it } from "vitest";
import { seal } from "../auth/crypto.ts";
import { createShareCredentialCodec } from "./credentials.ts";
import { createShareLimiter } from "./limiter.ts";

const id = "00000000-0000-4000-8000-000000000001";
it("purpose-separates, bounds, authenticates and expires credential envelopes", () => {
  const master = Buffer.alloc(32, 1);
  let now = new Date(1000000);
  const codec = createShareCredentialCodec(master, () => now);
  const value = codec.encode(id, "secret");
  expect(value).not.toContain("secret");
  expect(codec.decode(id, value)).toBe("secret");
  expect(codec.decode(id, codec.encode(id, ""))).toBe("");
  for (const bad of [undefined, "", `${value}=`, "a".repeat(3801), "A", `${value.slice(0, -3)}zzz`])
    expect(codec.decode(id, bad)).toBeUndefined();
  expect(codec.decode("00000000-0000-4000-8000-000000000002", value)).toBeUndefined();
  expect(
    createShareCredentialCodec(Buffer.alloc(32, 2), () => now).decode(id, value),
  ).toBeUndefined();
  expect(() => codec.encode(id, "\0".repeat(1024))).toThrow("too large");
  expect(() => codec.encode("bad", "secret")).toThrow();
  now = new Date(5000000);
  expect(codec.decode(id, value)).toBeUndefined();
  now = new Date(0);
  expect(codec.decode(id, value)).toBeUndefined();
  const key = new Uint8Array(
    hkdfSync("sha256", master, new Uint8Array(), "fdrive-public-share-credentials-v1", 32),
  );
  for (const payload of [
    { id: "00000000-0000-4000-8000-000000000002", password: "p", expires: 1000 },
    { id, password: 5, expires: 1000 },
  ])
    expect(
      codec.decode(
        id,
        Buffer.from(seal(key, Buffer.from(JSON.stringify(payload)), id)).toString("base64url"),
      ),
    ).toBeUndefined();
});
it("bounds per-IP/share requests, credentials, capacity and expiry", () => {
  let now = new Date(0);
  const limiter = createShareLimiter(() => now, 2);
  for (let i = 0; i < 120; i++) expect(limiter.allow("a", id, false)).toBe(true);
  expect(limiter.allow("a", id, false)).toBe(false);
  for (let i = 0; i < 10; i++) expect(limiter.allow("b", id, true)).toBe(true);
  expect(limiter.allow("b", id, true)).toBe(false);
  expect(limiter.allow("c", id, false)).toBe(false);
  now = new Date(60000);
  expect(limiter.allow("c", id, false)).toBe(true);
});
