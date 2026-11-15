import { hkdfSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { seal } from "../auth/crypto.ts";
import {
  createShareCredentialCodec,
  newShareVisitor,
  SHARE_PREVIEW_SECONDS,
  shareVisitor,
} from "./credentials.ts";
import { createShareLimiter } from "./limiter.ts";

const id = "00000000-0000-4000-8000-000000000001";
it("purpose-separates, bounds, authenticates and expires credential envelopes", () => {
  const master = Buffer.alloc(32, 1);
  let now = new Date(1000000);
  const codec = createShareCredentialCodec(master, () => now);
  const value = codec.encode(id, { verified: "v1-marker" });
  expect(value).not.toContain("v1-marker");
  expect(codec.decode(id, value)).toEqual({ verified: "v1-marker" });
  expect(() => codec.encode(id, { verified: "" })).toThrow();
  expect(() => codec.encode(id, { verified: "x".repeat(65) })).toThrow();
  expect(() => codec.encode("bad", { verified: "v1" })).toThrow();
  for (const bad of [undefined, "", `${value}=`, "a".repeat(3801), "A", `${value.slice(0, -3)}zzz`])
    expect(codec.decode(id, bad)).toBeUndefined();
  expect(codec.decode("00000000-0000-4000-8000-000000000002", value)).toBeUndefined();
  expect(
    createShareCredentialCodec(Buffer.alloc(32, 2), () => now).decode(id, value),
  ).toBeUndefined();
  now = new Date(5000000);
  expect(codec.decode(id, value)).toBeUndefined();
  now = new Date(0);
  expect(codec.decode(id, value)).toBeUndefined();
  const key = new Uint8Array(
    hkdfSync("sha256", master, new Uint8Array(), "fdrive-public-share-credentials-v1", 32),
  );
  for (const payload of [
    { id: "00000000-0000-4000-8000-000000000002", verified: "v", expires: 1000 },
    { id, verified: 5, expires: 1000 },
    // The password form SFTPGo links needed is no credential any more.
    { id, password: "p", expires: 1000 },
    { id, password: "p", verified: "v", expires: 1000 },
    { id, expires: 1000 },
  ])
    expect(
      codec.decode(
        id,
        Buffer.from(seal(key, Buffer.from(JSON.stringify(payload)), id)).toString("base64url"),
      ),
    ).toBeUndefined();
});
it("binds a preview token to one share, one file, one visitor and five minutes", () => {
  const master = Buffer.alloc(32, 1);
  let now = new Date(1_000_000);
  const codec = createShareCredentialCodec(master, () => now);
  const visitor = newShareVisitor();
  const other = newShareVisitor();
  expect(visitor).not.toBe(other);
  expect(shareVisitor(visitor)).toBe(visitor);
  for (const bad of [undefined, "", "short", `${visitor}x`, `${visitor.slice(1)}!`])
    expect(shareVisitor(bad), bad).toBeUndefined();
  const token = codec.previewToken(id, "/clip.mp4", visitor);
  expect(codec.previewed(id, "/clip.mp4", visitor, token)).toBe(true);
  expect(codec.previewed(id, "/clip.mp4", other, token)).toBe(false);
  expect(codec.previewed(id, "/other.mp4", visitor, token)).toBe(false);
  expect(codec.previewed("00000000-0000-4000-8000-000000000002", "/clip.mp4", visitor, token)).toBe(
    false,
  );
  expect(
    createShareCredentialCodec(Buffer.alloc(32, 2), () => now).previewed(
      id,
      "/clip.mp4",
      visitor,
      token,
    ),
  ).toBe(false);
  const [expires, mac] = token.split(".");
  for (const bad of [
    "",
    "nonsense",
    `${expires}.${mac}x`,
    `${expires}.${mac?.slice(1)}`,
    `${(Number.parseInt(expires ?? "", 36) + 1).toString(36)}.${mac}`,
    `${"z".repeat(12)}.${mac}`,
  ])
    expect(codec.previewed(id, "/clip.mp4", visitor, bad), bad).toBe(false);
  // A token from further ahead than one is ever issued is no token.
  const ahead = createShareCredentialCodec(master, () => new Date(now.getTime() + 60_000));
  expect(
    codec.previewed(id, "/clip.mp4", visitor, ahead.previewToken(id, "/clip.mp4", visitor)),
  ).toBe(false);
  now = new Date(now.getTime() + SHARE_PREVIEW_SECONDS * 1000 - 1);
  expect(codec.previewed(id, "/clip.mp4", visitor, token)).toBe(true);
  now = new Date(now.getTime() + 1);
  expect(codec.previewed(id, "/clip.mp4", visitor, token)).toBe(false);
});
it("bounds known and unknown requests independently, credentials, capacity and expiry", async () => {
  let now = new Date(0);
  const limiter = createShareLimiter(() => now, 2);
  const classifyKnown = vi.fn(async () => true);
  const classifyUnknown = vi.fn(async () => false);
  for (let i = 0; i < 120; i++)
    expect(await limiter.allow("a", id, false, classifyKnown)).toBe(true);
  expect(await limiter.allow("a", id, false, classifyKnown)).toBe(false);
  for (let i = 0; i < 10; i++) expect(await limiter.allow("b", id, true, classifyKnown)).toBe(true);
  expect(await limiter.allow("b", id, true, classifyKnown)).toBe(false);
  expect(await limiter.allow("c", id, false, classifyKnown)).toBe(false);
  for (let i = 0; i < 120; i++)
    expect(await limiter.allow("c", "unknown-1", false, classifyUnknown)).toBe(true);
  expect(await limiter.allow("c", "unknown-1", false, classifyUnknown)).toBe(false);
  expect(await limiter.allow("d", "unknown-2", false, classifyUnknown)).toBe(true);
  expect(await limiter.allow("e", "unknown-3", false, classifyUnknown)).toBe(false);
  expect(classifyKnown).toHaveBeenCalledTimes(1);
  expect(classifyUnknown).toHaveBeenCalledTimes(3);
  now = new Date(60000);
  expect(await limiter.allow("a", id, false, classifyKnown)).toBe(true);
  expect(await limiter.allow("c", id, false, classifyKnown)).toBe(true);
  expect(await limiter.allow("e", "unknown-3", false, classifyUnknown)).toBe(true);
});

it("deduplicates concurrent classification for one share", async () => {
  const limiter = createShareLimiter(() => new Date(0));
  let resolve!: (known: boolean) => void;
  const pending = new Promise<boolean>((done) => {
    resolve = done;
  });
  const classify = vi.fn(() => pending);
  const first = limiter.allow("a", id, false, classify);
  const second = limiter.allow("b", id, false, classify);
  resolve(true);
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(classify).toHaveBeenCalledTimes(1);
});
