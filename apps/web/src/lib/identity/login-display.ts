import type { IdentitySummary, ProviderType } from "@fdrive/contracts";
import { providerTypeLabel } from "./provider-type";

/**
 * Provider types whose `username` credential is an access key rather than a
 * person's name. Their logins lead with the storage name, so the switcher
 * and the Logins card never headline an opaque key ID.
 */
export const KEY_LOGIN_TYPES: ReadonlySet<ProviderType> = new Set<ProviderType>(["s3"]);

export interface LoginDisplay {
  /** The prominent line: the person's username, or the storage name for key logins. */
  readonly title: string;
  /** The line beneath, shown beside the provider type icon: the storage name, or the key. */
  readonly detail: string;
}

/**
 * How a login is presented wherever it is listed. Both the storage name and
 * the username stay visible; only their order depends on the provider type.
 */
export function loginDisplay(
  identity: Pick<IdentitySummary, "username" | "providerLabel" | "providerType">,
): LoginDisplay {
  const storage = identity.providerLabel || providerTypeLabel(identity.providerType);
  return KEY_LOGIN_TYPES.has(identity.providerType)
    ? { title: storage, detail: identity.username }
    : { title: identity.username, detail: storage };
}
