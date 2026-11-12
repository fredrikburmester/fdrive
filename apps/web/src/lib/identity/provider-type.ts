import type { ProviderType } from "@fdrive/contracts";

/**
 * The product name of each provider type, for copy that names the kind of
 * server a login belongs to ("Connected to WebDAV at ..."). The row's own
 * `label` names the specific server; this names the software. The local
 * folder is fdrive's own storage, so its accounts are fdrive accounts.
 */
export const PROVIDER_TYPE_LABELS: Readonly<Record<ProviderType, string>> = {
  local: "fdrive",
  webdav: "WebDAV",
  s3: "S3",
};

/** `PROVIDER_TYPE_LABELS[type]`, falling back to the raw type for a value this build does not know. */
export function providerTypeLabel(type: string): string {
  return (PROVIDER_TYPE_LABELS as Record<string, string | undefined>)[type] ?? type;
}
