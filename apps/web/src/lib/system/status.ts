/** The three states a sidecar-backed System page can be in. */
export type SidecarStatus = "ok" | "unreachable" | "not_configured";

/**
 * Resolves a sidecar's status badge from the API's `configured`/`reachable`
 * flags: not configured (its base URL env var is unset), configured but
 * unreachable (the API could not reach it within its timeout), or ok.
 */
export function sidecarStatus(configured: boolean, reachable: boolean): SidecarStatus {
  if (!configured) {
    return "not_configured";
  }
  return reachable ? "ok" : "unreachable";
}

/** Human label for a `SidecarStatus`, used by `StatusBadge`. */
export function sidecarStatusLabel(status: SidecarStatus): string {
  switch (status) {
    case "ok":
      return "Reachable";
    case "unreachable":
      return "Unreachable";
    case "not_configured":
      return "Not configured";
  }
}
