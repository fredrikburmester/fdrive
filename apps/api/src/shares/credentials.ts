import { hkdfSync } from "node:crypto";
import { ShareCredentialsRequest, ShareId } from "@fdrive/contracts";
import { z } from "zod";
import { open, seal } from "../auth/crypto.ts";
import { ApiHttpError } from "../errors.ts";

export const SHARE_CREDENTIAL_COOKIE = "fdrive-share-credential";
export const SHARE_CREDENTIAL_SECONDS = 3600;
const Payload = ShareCredentialsRequest.extend({
  id: ShareId,
  expires: z.number().int().positive(),
}).strict();
export function createShareCredentialCodec(master: Uint8Array, clock: () => Date) {
  const key = new Uint8Array(
    hkdfSync("sha256", master, new Uint8Array(), "fdrive-public-share-credentials-v1", 32),
  );
  return {
    encode(id: string, password: string): string {
      const payload = Payload.parse({
        id,
        password,
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
    decode(id: string, value: string | undefined): string | undefined {
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
        return payload.password;
      } catch {
        return undefined;
      }
    },
  };
}
export type ShareCredentialCodec = ReturnType<typeof createShareCredentialCodec>;
