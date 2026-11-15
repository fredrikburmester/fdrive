import { isLocalUsername } from "@fdrive/local";
import { ApiHttpError } from "../errors.js";
import type { LocalUserStore } from "../local/users.js";
import { addressBlock } from "./address-block.js";
import type { LoginLimiter } from "./login-limiter.js";

export interface PasswordCheckInput {
  /** A local user's name, in any case. */
  readonly username: string;
  readonly password: string;
  /** The caller's address, for the limiter. */
  readonly ip: string;
}

/**
 * Checks a local user's password behind the login limiter. Resolves to the
 * name as stored; throws `rate_limited`, `unauthorized` for a wrong name or
 * password, or `forbidden` for a disabled user (told so only with the right
 * password).
 */
export type CheckPassword = (input: PasswordCheckInput) => Promise<string>;

/**
 * The limiter key shared by every password check from one address block,
 * distinct from `block|username` and setup's `setup|block`. Keying it on the
 * block (`addressBlock`) rather than the raw address is what keeps it a
 * bound at all against an IPv6 caller, which can source from any address
 * in its /64.
 */
export function loginIpKey(ip: string): string {
  return `login-ip|${addressBlock(ip)}`;
}

/**
 * The one password check: sign-in, setup's sign-in, changing one's own
 * password and unlocking backups all go through it, so they share the
 * limiter's failure counts.
 */
export function createPasswordCheck(deps: {
  readonly limiter: LoginLimiter;
  readonly users: Pick<LocalUserStore, "verify">;
}): CheckPassword {
  return async ({ username, password, ip }) => {
    const block = addressBlock(ip);
    // Names are unique in any case, so every spelling counts against one key.
    const key = `${block}|${username.toLowerCase()}`;
    // An independent per-address bucket bounds password spraying: without it
    // one address gets a fresh allowance for every username it tries. It is
    // never cleared by a success, so knowing one valid login cannot reset it.
    // It is passed ungrouped, since there is one of it per block and it must
    // stay trackable however many usernames that block has already tried.
    const ipKey = loginIpKey(ip);
    const status = deps.limiter.check(key, block);
    const ipStatus = deps.limiter.check(ipKey);
    if (!status.allowed || !ipStatus.allowed) {
      throw new ApiHttpError("rate_limited", "too many failed login attempts", {
        retryAfterMs: Math.max(status.retryAfterMs ?? 0, ipStatus.retryAfterMs ?? 0),
      });
    }
    const check = isLocalUsername(username)
      ? await deps.users.verify(username, password)
      : ({ result: "invalid" } as const);
    if (check.result === "disabled") {
      throw new ApiHttpError("forbidden", "this user may not sign in");
    }
    if (check.result !== "ok") {
      deps.limiter.recordFailure(key, block);
      deps.limiter.recordFailure(ipKey);
      throw new ApiHttpError("unauthorized", "invalid username or password");
    }
    deps.limiter.recordSuccess(key);
    return check.username;
  };
}
