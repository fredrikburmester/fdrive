/**
 * Cloud instance-metadata endpoints no storage backend may point at. A
 * provider address that names one is refused before any request is sent,
 * whatever the type: the probe and the signed client both run from the API
 * process, whose metadata service would otherwise answer as "the backend".
 */
const PROHIBITED_METADATA_HOSTS: ReadonlySet<string> = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "169.254.169.253",
  "100.100.100.200",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata.google",
]);

/** True when a URL's `hostname` (bracketed IPv6 included) is a cloud metadata service. */
export function isProhibitedMetadataHost(hostname: string): boolean {
  return PROHIBITED_METADATA_HOSTS.has(hostname.toLowerCase().replace(/^\[|\]$/g, ""));
}
