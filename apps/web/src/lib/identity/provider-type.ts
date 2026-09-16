import type { ProviderType } from "@fdrive/contracts";

/**
 * The product name of each provider type, for copy that names the kind of
 * server a login belongs to ("Connected to SFTPGo at ..."). The row's own
 * `label` names the specific server; this names the software.
 */
export const PROVIDER_TYPE_LABELS: Readonly<Record<ProviderType, string>> = {
  sftpgo: "SFTPGo",
  webdav: "WebDAV",
  s3: "S3",
};

/** `PROVIDER_TYPE_LABELS[type]`, falling back to the raw type for a value this build does not know. */
export function providerTypeLabel(type: string): string {
  return (PROVIDER_TYPE_LABELS as Record<string, string | undefined>)[type] ?? type;
}
