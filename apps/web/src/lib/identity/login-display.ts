import type { IdentitySummary } from "@fdrive/contracts";
import { providerTypeLabel } from "./provider-type";

export interface LoginDisplay {
  /** The prominent line: the person's username. */
  readonly title: string;
  /** The line beneath, shown beside the storage icon: the storage name. */
  readonly detail: string;
}

/**
 * How a login is presented wherever it is listed: the username first, the
 * storage's name beneath it, or the product name while it has none.
 */
export function loginDisplay(
  identity: Pick<IdentitySummary, "username" | "providerLabel" | "providerType">,
): LoginDisplay {
  return {
    title: identity.username,
    detail: identity.providerLabel || providerTypeLabel(identity.providerType),
  };
}
