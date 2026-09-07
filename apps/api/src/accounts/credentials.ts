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
  const baseUrl = connection.baseUrl;
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
  const current = await deps.connectionStore.current();
  if (current?.baseUrl !== baseUrl)
    throw new ApiHttpError("unauthorized", "storage connection changed; sign in again");
  deps.limiter.recordSuccess(key);
  const provider = await deps.repos.providers.ensure({
    type: "sftpgo",
    baseUrl,
  });
  await requireCurrentConnection(deps.connectionStore, baseUrl);
  return { provider, token };
}
