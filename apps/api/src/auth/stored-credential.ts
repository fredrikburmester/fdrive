import type { ProviderCredential } from "@fdrive/core";

/** Parses a sealed credential; anything that is not a JSON object of strings is empty. */
export function parseStoredCredential(bytes: Uint8Array): ProviderCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}
