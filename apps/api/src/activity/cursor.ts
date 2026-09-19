import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiHttpError } from "../errors.js";

/**
 * Signed, opaque pagination positions. The owner and the complete filter set
 * are signed into every cursor, so a cursor cannot be replayed against another
 * account or against a different query than the one that produced it.
 */
export function createActivityCursors(secret: string) {
  function signature(body: string) {
    return createHmac("sha256", secret).update(`activity:v1:${body}`).digest();
  }
  return {
    encode(owner: string, binding: string, value: string) {
      const body = Buffer.from(JSON.stringify([owner, binding, value])).toString("base64url");
      return `${body}.${signature(body).toString("base64url")}`;
    },
    decode(owner: string, binding: string, cursor: string) {
      try {
        const [body, mac, extra] = cursor.split(".");
        if (!body || !mac || extra) throw Error();
        const expected = signature(body);
        const actual = Buffer.from(mac, "base64url");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
        const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString());
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 3 ||
          parsed[0] !== owner ||
          parsed[1] !== binding ||
          typeof parsed[2] !== "string"
        )
          throw Error();
        return parsed[2];
      } catch {
        throw new ApiHttpError("bad_request", "Invalid activity cursor");
      }
    },
  };
}
