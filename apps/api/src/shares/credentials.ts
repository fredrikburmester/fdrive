import { hkdfSync } from "node:crypto";
import { ShareId } from "@fdrive/contracts";
import { z } from "zod";
import { open, seal } from "../auth/crypto.ts";
import { ApiHttpError } from "../errors.ts";

export const SHARE_CREDENTIAL_COOKIE = "fdrive-share-credential";
export const SHARE_CREDENTIAL_SECONDS = 3600;

/**
 * What a visitor's credential cookie carries for one share: the password
 * itself, for a backend that checks it on every operation (SFTPGo), or a
 * verified marker, the password version fdrive itself checked the password
 * against once, for a share fdrive serves. Either way the cookie is sealed
 * and bound to the share id; only the service decides which form to issue.
 */
export type ShareCredential = { readonly password: string } | { readonly verified: string };

const Payload = z
  .strictObject({
    id: ShareId,
    expires: z.number().int().positive(),
    password: z.string().max(1024).optional(),
    verified: z.string().min(1).max(64).optional(),
  })
  .refine((payload) => (payload.password === undefined) !== (payload.verified === undefined));

export function createShareCredentialCodec(master: Uint8Array, clock: () => Date) {
  const key = new Uint8Array(
    hkdfSync("sha256", master, new Uint8Array(), "fdrive-public-share-credentials-v1", 32),
  );
  return {
    encode(id: string, credential: ShareCredential): string {
      const payload = Payload.parse({
        id,
        ...credential,
        expires: clock().getTime() + SHARE_CREDENTIAL_SECONDS * 1000,
      });
      const value = Buffer.from(seal(key, Buffer.from(JSON.stringify(payload)), id)).toString(
        "base64url",
      );
      if (value.length > 3800)
        throw new ApiHttpError(
          "bad_request",
          "Password is too large to store securely in this browser. Use a shorter password.",
        );
      return value;
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
        return payload.password !== undefined
          ? { password: payload.password }
          : { verified: payload.verified ?? "" };
      } catch {
        return undefined;
      }
    },
  };
}
export type ShareCredentialCodec = ReturnType<typeof createShareCredentialCodec>;
