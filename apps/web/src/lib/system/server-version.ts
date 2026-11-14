import type { AboutResponse } from "@fdrive/contracts";

/** What the About page shows as the server version. */
export interface ServerVersion {
  /** The release (`0.1.0`, `main`) or a development label. */
  readonly label: string;
  /** Full Git commit to link, or null when unknown. */
  readonly revision: string | null;
}

/** The release, or a development label, with the commit when the server knows it. */
export function describeServerVersion({
  release,
  revision,
}: Pick<AboutResponse, "release" | "revision">): ServerVersion {
  if (release !== undefined) return { label: release, revision: revision ?? null };
  if (revision !== undefined) return { label: "Development", revision };
  return { label: "Development (version unavailable)", revision: null };
}
