import type { AboutResponse } from "@fdrive/contracts";

/** What the About page shows as the server version. */
export interface ServerVersion {
  /** The release (`0.1.0`, `main`) or a development label; null when only a commit is known. */
  readonly label: string | null;
  /** Full Git commit to link, or null when unknown. */
  readonly revision: string | null;
}

/**
 * The release, or a development label, with the commit when the server knows it.
 * Servers from before releases send only `version`: either their commit, shown
 * alone as before because nothing says whether it was a release, or a
 * development placeholder.
 */
export function describeServerVersion({
  version,
  release,
  revision,
}: Pick<AboutResponse, "version" | "release" | "revision">): ServerVersion {
  if (release !== undefined || revision !== undefined) {
    return { label: release ?? "Development", revision: revision ?? null };
  }
  if (/^[a-f0-9]{40,64}$/i.test(version)) return { label: null, revision: version };
  const unknown = version === "development" || version === "0.0.0";
  return { label: unknown ? "Development (version unavailable)" : version, revision: null };
}
