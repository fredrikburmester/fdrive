import { SftpgoError } from "@fdrive/sftpgo";
import { requireCurrentConnection } from "../auth/provider-client.ts";
import { ApiHttpError } from "../errors.js";
import type { VerifiedCredentialDeps } from "./types.ts";

/** Shared verification and limiter, with no account/session writes before success. */
export async function verifyAccountCredentials(
  deps: VerifiedCredentialDeps,
  input: { username: string; password: string; otp?: string | undefined; ip: string },
) {
  const connection = await deps.connectionStore.current();
  if (connection === null)
    throw new ApiHttpError("setup_required", "no SFTPGo connection is configured yet");
  return verifyCredentialsAt(deps, input, connection.baseUrl, true);
}

/**
 * Verifies a setup candidate without consulting or changing the active
 * connection. The resulting provider remains permanently bound to this URL.
 */
export async function verifyCandidateCredentials(
  deps: Pick<VerifiedCredentialDeps, "repos" | "clientForBaseUrl" | "limiter">,
  input: { username: string; password: string; otp?: string | undefined; ip: string },
  baseUrl: string,
) {
  return verifyCredentialsAt(deps, input, baseUrl, false);
}

async function verifyCredentialsAt(
  deps: Pick<VerifiedCredentialDeps, "repos" | "clientForBaseUrl" | "limiter"> &
    Partial<Pick<VerifiedCredentialDeps, "connectionStore">>,
  input: { username: string; password: string; otp?: string | undefined; ip: string },
  baseUrl: string,
  requireActiveConnection: boolean,
) {
  const client = deps.clientForBaseUrl(baseUrl);
  const key = `${input.ip}|${input.username}`;
  const status = deps.limiter.check(key);
  if (!status.allowed)
    throw new ApiHttpError("rate_limited", "too many failed login attempts", {
      retryAfterMs: status.retryAfterMs ?? 0,
    });
  let token: { accessToken: string; expiresAt: Date };
  try {
    token = await client.login({
      username: input.username,
      password: input.password,
      ...(input.otp === undefined ? {} : { otp: input.otp }),
    });
  } catch (error) {
    if (error instanceof SftpgoError) {
      if (error.kind === "unauthorized") {
        deps.limiter.recordFailure(key);
        throw new ApiHttpError("unauthorized", "invalid username or password");
      }
      if (error.kind === "forbidden")
        throw new ApiHttpError("forbidden", error.detail ?? "forbidden");
    }
    throw new ApiHttpError("upstream_unavailable", "SFTPGo is unavailable");
  }
  if (requireActiveConnection) {
    const current = await deps.connectionStore?.current();
    if (current?.baseUrl !== baseUrl)
      throw new ApiHttpError("unauthorized", "storage connection changed; sign in again");
  }
  deps.limiter.recordSuccess(key);
  const provider = await deps.repos.providers.ensure({
    type: "sftpgo",
    baseUrl,
  });
  if (requireActiveConnection && deps.connectionStore !== undefined) {
    await requireCurrentConnection(deps.connectionStore, baseUrl);
  }
  return { provider, token };
}
