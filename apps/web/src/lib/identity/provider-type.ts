import type { ProviderType } from "@fdrive/contracts";

/**
 * The product name of each provider type, for copy that names the kind of
 * account a login is. The row's own `label` names the specific storage; this
 * names the software. The files folder is fdrive's own storage, so its
 * accounts are fdrive accounts.
 */
export const PROVIDER_TYPE_LABELS: Readonly<Record<ProviderType, string>> = {
  local: "fdrive",
};

/** `PROVIDER_TYPE_LABELS[type]`, falling back to the raw type for a value this build does not know. */
export function providerTypeLabel(type: string): string {
  return (PROVIDER_TYPE_LABELS as Record<string, string | undefined>)[type] ?? type;
}
