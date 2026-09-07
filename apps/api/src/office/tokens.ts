import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const claimsSchema = z.strictObject({
  iss: z.literal("fdrive"),
  aud: z.literal("fdrive:wopi"),
  sub: z.uuid(),
  identityId: z.uuid(),
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(["view", "edit"]),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type OfficeClaims = z.infer<typeof claimsSchema>;
const HEADER = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
export function createOfficeTokenCodec(master: Uint8Array) {
  if (master.byteLength !== 32) throw new Error("Invalid office signing key");
  const key = Buffer.from(
    hkdfSync("sha256", master, "fdrive:office:v1", "fdrive:wopi:access-token", 32),
  );
  function signature(body: string): Buffer {
    return createHmac("sha256", key).update(body).digest();
  }
  return {
    mint(input: {
      fileId: string;
      identityId: string;
      sessionHash: string;
      mode: "view" | "edit";
      now: Date;
      sessionExpiresAt: Date;
    }) {
      const iat = Math.floor(input.now.getTime() / 1000);
      const exp = Math.min(iat + 8 * 3600, Math.floor(input.sessionExpiresAt.getTime() / 1000));
      const claims = claimsSchema.parse({
        iss: "fdrive",
        aud: "fdrive:wopi",
        sub: input.fileId,
        identityId: input.identityId,
        sessionHash: input.sessionHash,
        mode: input.mode,
        iat,
        exp,
      });
      if (exp <= iat) throw new Error("Session expired");
      const body = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
      return {
        token: `${body}.${signature(body).toString("base64url")}`,
        expiresAt: new Date(exp * 1000),
      };
    },
    verify(token: string, now: Date): OfficeClaims | null {
      try {
        if (
          token.length > 4096 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)
        )
          return null;
        const [header, payload, mac] = token.split(".");
        if (header !== HEADER || payload === undefined || mac === undefined) return null;
        const actual = Buffer.from(mac, "base64url");
        if (
          actual.toString("base64url") !== mac ||
          !timingSafeEqual(actual, signature(`${header}.${payload}`))
        )
          return null;
        const claims = claimsSchema.parse(
          JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        );
        const seconds = Math.floor(now.getTime() / 1000);
        if (
          !Number.isFinite(seconds) ||
          claims.exp <= seconds ||
          claims.iat > seconds ||
          claims.exp <= claims.iat ||
          claims.exp - claims.iat > 8 * 3600
        )
          return null;
        return claims;
      } catch {
        return null;
      }
    },
  };
}
export type OfficeTokenCodec = ReturnType<typeof createOfficeTokenCodec>;
