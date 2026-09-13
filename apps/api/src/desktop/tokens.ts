import { randomBytes } from "node:crypto";

// The prefix is included in the persisted hash. Replacing it cannot turn an MCP token
// into a desktop token, or vice versa, even though both use the existing revocation table.
export function generateDesktopToken(): string {
  return `fdd_${randomBytes(32).toString("base64url")}`;
}
export function looksLikeDesktopToken(value: string): boolean {
  return /^fdd_[A-Za-z0-9_-]{43}$/.test(value);
}
