import type { ConnectionSource } from "@fdrive/contracts";

/** Human-readable label for where the active connection's base URL comes from. */
export function connectionSourceLabel(source: ConnectionSource): string {
  return source === "env" ? "Environment (locked)" : "Settings";
}

/**
 * True when `value` looks like a usable home template: `<root>:<path>`
 * with a lowercase root name and a path starting with `/`. This is a
 * cheap client-side sanity check only; the API is the source of truth and
 * validates with `parseHomeTemplate` from `@fdrive/core`.
 */
export function isPlausibleHomeTemplate(value: string): boolean {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    return false;
  }
  const root = value.slice(0, separatorIndex);
  const path = value.slice(separatorIndex + 1);
  return /^[a-z0-9][a-z0-9_-]*$/.test(root) && path.startsWith("/");
}

/**
 * Builds the one-line preview of what a home template resolves to for a
 * given username, e.g. "alice -> sftpgo:/alice". Falls back to the
 * placeholder username "alice" when `username` is blank, so the preview is
 * never empty while the setup form's account fields are still unfilled.
 */
export function homeTemplatePreview(template: string, username: string): string {
  const resolvedUsername = username.trim().length > 0 ? username.trim() : "alice";
  const resolvedPath = template.replaceAll("{username}", resolvedUsername);
  return `${resolvedUsername} → ${resolvedPath}`;
}

/** True when the draft home template differs from the currently saved one, ignoring surrounding whitespace. */
export function hasHomeTemplateChanged(saved: string, draft: string): boolean {
  return saved.trim() !== draft.trim();
}
