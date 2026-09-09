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

/**
 * The Office service's own four-state status as one of the three badges
 * every other System page uses: `ready` is reachable, `off` means the owner
 * has not turned it on, and both `starting` and `unavailable` are "not
 * reachable yet" — the Office page's description says which of the two it
 * is, since only the transient one resolves on its own.
 */
export function officeStatus(status: "off" | "starting" | "ready" | "unavailable"): SidecarStatus {
  switch (status) {
    case "ready":
      return "ok";
    case "off":
      return "not_configured";
    default:
      return "unreachable";
  }
}
