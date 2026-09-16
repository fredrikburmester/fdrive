import type { ProviderCredential, ProviderToken } from "@fdrive/core";
import { isStorageError, stripTransientFields, validateFields } from "@fdrive/core";
import { addressBlock } from "../auth/address-block.js";
import { ApiHttpError } from "../errors.js";
import type { ResolvedProvider } from "../providers/service.js";
import type { VerifiedCredentialDeps } from "./types.ts";

export interface VerifyCredentialInput {
  /** Omitted when exactly one provider is enabled. */
  readonly providerId?: string | undefined;
  /** Values for the provider's `credentialFields`. */
  readonly credential: Readonly<Record<string, string>>;
  readonly ip: string;
  /**
   * The username of the login being re-proved (link and unlink confirm the
   * signed-in login with its own credential). The module fills a missing
   * username field from it and refuses a credential naming someone else.
   */
  readonly expectedUsername?: string | undefined;
}

export interface VerifiedCredential extends ResolvedProvider {
  readonly externalUsername: string;
  /** The credential as it is stored: validated, transient fields removed. */
  readonly stored: ProviderCredential;
  readonly token: ProviderToken | undefined;
}

/**
 * The limiter key shared by every login attempt from one address block,
 * distinct from `ip|username` and setup's `setup|ip`. Keying it on the
 * block (`addressBlock`) rather than the raw address is what keeps it a
 * bound at all against an IPv6 caller, which can source from any address
 * in its /64.
 */
export function loginIpKey(ip: string): string {
  return `login-ip|${addressBlock(ip)}`;
}

/**
 * Picks the provider a credential is meant for: the requested one, else the
 * only enabled one. `setup_required` before any provider exists,
 * `bad_request` when several are enabled and none was named.
 */
async function targetProvider(
  deps: Pick<VerifiedCredentialDeps, "providers">,
  providerId: string | undefined,
  allowDisabled: boolean,
): Promise<ResolvedProvider> {
  if (providerId !== undefined) {
    return deps.providers.resolve(providerId, { allowDisabled });
  }
  const enabled = await deps.providers.enabled();
  const [only] = enabled;
  if (only === undefined) {
    throw new ApiHttpError("setup_required", "no storage provider is configured yet");
  }
  if (enabled.length > 1) {
    throw new ApiHttpError("bad_request", "providerId is required when several providers exist");
  }
  return deps.providers.resolve(only.id);
}

/**
 * Verifies a credential against its provider through the provider module,
 * behind the login rate limiter. Performs no account or session writes;
 * the caller decides what a success means. `allowDisabled` lets setup
 * verify against a provider that is not yet enabled.
 */
export async function verifyCredentials(
  deps: VerifiedCredentialDeps,
  input: VerifyCredentialInput,
  opts: {
    allowDisabled?: boolean;
    beforeAuthenticate?: (providerId: string, username: string) => Promise<void>;
  } = {},
): Promise<VerifiedCredential> {
  const target = await targetProvider(deps, input.providerId, opts.allowDisabled ?? false);
  const fields = target.module.credentialFields;
  const hasUsernameField = fields.some((field) => field.name === "username");
  const raw =
    input.expectedUsername !== undefined &&
    hasUsernameField &&
    input.credential.username === undefined
      ? { ...input.credential, username: input.expectedUsername }
      : input.credential;
  const validated = validateFields(fields, raw);
  if (!validated.ok) {
    throw new ApiHttpError("bad_request", "invalid credential", { issues: validated.issues });
  }

  const usernameHint = validated.value.username ?? input.expectedUsername ?? "";
  const block = addressBlock(input.ip);
  const key = `${block}|${target.provider.id}|${usernameHint}`;
  // An independent per-address bucket bounds password spraying: without it
  // one address gets a fresh allowance for every username it tries. It is
  // never cleared by a success, so knowing one valid login cannot reset it.
  // It is passed ungrouped, since there is one of it per block and it must
  // stay trackable however many usernames that block has already tried.
  const ipKey = loginIpKey(input.ip);
  const status = deps.limiter.check(key, block);
  const ipStatus = deps.limiter.check(ipKey);
  if (!status.allowed || !ipStatus.allowed)
    throw new ApiHttpError("rate_limited", "too many failed login attempts", {
      retryAfterMs: Math.max(status.retryAfterMs ?? 0, ipStatus.retryAfterMs ?? 0),
    });

  await opts.beforeAuthenticate?.(target.provider.id, usernameHint);

  let result: Awaited<ReturnType<ResolvedProvider["module"]["authenticate"]>>;
  try {
    result = await target.module.authenticate(target.instance, validated.value, {
      fetch: deps.fetch,
      ...(input.expectedUsername === undefined ? {} : { expectedUsername: input.expectedUsername }),
    });
  } catch (error) {
    if (isStorageError(error)) {
      if (error.kind === "unauthorized") {
        deps.limiter.recordFailure(key, block);
        deps.limiter.recordFailure(ipKey);
        // Named by the provider's own credential labels: "invalid username
        // or password" for SFTPGo and WebDAV, "invalid access key ID or
        // secret key" for S3, so the form can show what was refused.
        const labels = fields
          .filter((field) => field.required)
          .map((field) => field.label.toLowerCase().replace(/ id$/, " ID"));
        throw new ApiHttpError("unauthorized", `invalid ${labels.join(" or ")}`);
      }
      if (error.kind === "forbidden") {
        const detail = error.details?.detail;
        throw new ApiHttpError("forbidden", typeof detail === "string" ? detail : "forbidden");
      }
    }
    throw new ApiHttpError("upstream_unavailable", "storage provider is unavailable");
  }
  // The provider must still be what it was when the credential was sent:
  // a row disabled, removed or re-addressed while the upstream login was in
  // flight must not gain an identity (and a sealed credential) bound to a
  // server that never verified it.
  const current = await deps.providers
    .resolve(target.provider.id, { allowDisabled: opts.allowDisabled ?? false })
    .catch(() => null);
  if (
    current === null ||
    current.provider.type !== target.provider.type ||
    current.provider.baseUrl !== target.provider.baseUrl
  ) {
    throw new ApiHttpError("unauthorized", "storage provider changed; sign in again");
  }
  deps.limiter.recordSuccess(key);
  return {
    ...target,
    externalUsername: result.externalUsername,
    stored: stripTransientFields(fields, validated.value),
    token: result.token,
  };
}
