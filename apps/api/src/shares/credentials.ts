import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { ShareId } from "@fdrive/contracts";
import { z } from "zod";
import { open, seal } from "../auth/crypto.ts";

export const SHARE_CREDENTIAL_COOKIE = "fdrive-share-credential";
export const SHARE_CREDENTIAL_SECONDS = 3600;
/**
 * A random name for one browser visiting a share, httpOnly and only sent to
 * that share's routes. It names no one; it binds a preview to the browser
 * that opened it.
 */
export const SHARE_VISITOR_COOKIE = "fdrive-share-visitor";
/** How long a preview's reads go uncounted after it was opened and counted. */
export const SHARE_PREVIEW_SECONDS = 300;

/** A new visitor name for `SHARE_VISITOR_COOKIE`. */
export function newShareVisitor(): string {
  return randomBytes(16).toString("base64url");
}
/** The visitor a `SHARE_VISITOR_COOKIE` value names, or `undefined` for anything else. */
export function shareVisitor(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9_-]{22}$/.test(value) ? value : undefined;
}

/**
 * What a visitor's credential cookie carries for one share: the version of
 * the password fdrive checked once when the cookie was issued (`open` for a
 * share without one). The cookie is sealed and bound to the share id, so it
 * proves the check without holding the password; a new password changes the
 * version and so retires every cookie issued for the old one.
 */
export interface ShareCredential {
  readonly verified: string;
}

const Payload = z.strictObject({
  id: ShareId,
  expires: z.number().int().positive(),
  verified: z.string().min(1).max(64),
});

export function createShareCredentialCodec(master: Uint8Array, clock: () => Date) {
  const key = new Uint8Array(
    hkdfSync("sha256", master, new Uint8Array(), "fdrive-public-share-credentials-v1", 32),
  );
  const previewKey = new Uint8Array(
    hkdfSync("sha256", master, new Uint8Array(), "fdrive-public-share-previews-v1", 32),
  );
  const previewMac = (id: string, path: string, visitor: string, expires: number) =>
    createHmac("sha256", previewKey)
      .update(JSON.stringify([id, path, visitor, expires]))
      .digest();
  return {
    /**
     * A token for one preview of `path` through share `id` by `visitor`,
     * issued once that preview was counted: for `SHARE_PREVIEW_SECONDS` the
     * download route serves that file's reads to that visitor without
     * counting them. It holds no state: what it names is all it opens.
     */
    previewToken(id: string, path: string, visitor: string): string {
      const expires = clock().getTime() + SHARE_PREVIEW_SECONDS * 1000;
      const mac = previewMac(id, path, visitor, expires).toString("base64url");
      return `${expires.toString(36)}.${mac}`;
    },
    /** Whether `token` is a live preview of `path` through share `id` by `visitor`. */
    previewed(id: string, path: string, visitor: string, token: string): boolean {
      const match = /^([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (match === null) return false;
      const expires = Number.parseInt(match[1] ?? "", 36);
      const now = clock().getTime();
      if (expires <= now || expires > now + SHARE_PREVIEW_SECONDS * 1000) return false;
      const mac = Buffer.from(match[2] ?? "", "base64url");
      // Only the MAC as it was issued: decoding ignores the last character's unused bits.
      if (mac.length !== 32 || mac.toString("base64url") !== match[2]) return false;
      return timingSafeEqual(mac, previewMac(id, path, visitor, expires));
    },
    encode(id: string, credential: ShareCredential): string {
      const payload = Payload.parse({
        id,
        verified: credential.verified,
        expires: clock().getTime() + SHARE_CREDENTIAL_SECONDS * 1000,
      });
      return Buffer.from(seal(key, Buffer.from(JSON.stringify(payload)), id)).toString("base64url");
    },
    decode(id: string, value: string | undefined): ShareCredential | undefined {
      if (value === undefined || value.length > 3800 || !/^[A-Za-z0-9_-]+$/.test(value))
        return undefined;
      try {
        const blob = Buffer.from(value, "base64url");
        if (blob.toString("base64url") !== value) return undefined;
        const payload = Payload.parse(
          JSON.parse(Buffer.from(open(key, blob, id)).toString("utf8")),
        );
        const now = clock().getTime();
        if (
          payload.id !== id ||
          payload.expires <= now ||
          payload.expires > now + SHARE_CREDENTIAL_SECONDS * 1000
        )
          return undefined;
        return { verified: payload.verified };
      } catch {
        return undefined;
      }
    },
  };
}
export type ShareCredentialCodec = ReturnType<typeof createShareCredentialCodec>;
