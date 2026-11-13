import { hkdfSync } from "node:crypto";
import { ShareId } from "@fdrive/contracts";
import { z } from "zod";
import { open, seal } from "../auth/crypto.ts";

export const SHARE_CREDENTIAL_COOKIE = "fdrive-share-credential";
export const SHARE_CREDENTIAL_SECONDS = 3600;

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
  return {
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
