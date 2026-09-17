import {
  type AdminProvider,
  type AdminProviderUpdateRequest,
  isHttpUrl,
  type ProviderCapabilities,
  type ProviderField,
  ProviderName,
} from "@fdrive/contracts";
import { CAPABILITY_KEYS, type CapabilityKey } from "@/lib/identity/capabilities";

/** Human-readable label for where a provider's address comes from. */
export function connectionSourceLabel(managedByEnv: boolean): string {
  return managedByEnv ? "Environment (locked)" : "Settings";
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

/** The provider form's fields as edited, before they become a create or update request. */
export interface ProviderDraft {
  /** The free-text name of this row. */
  readonly label: string;
  readonly baseUrl: string;
  /** Configuration field values by field name, as typed. */
  readonly config: Readonly<Record<string, string>>;
}

/**
 * The initial values of a provider form's configuration fields: what is
 * stored for an existing provider, an empty string for anything the stored
 * configuration does not carry (or for a new provider).
 */
export function providerConfigDraft(
  fields: readonly ProviderField[],
  saved?: Readonly<Record<string, string>>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    values[field.name] = saved?.[field.name] ?? "";
  }
  return values;
}

/**
 * A configuration ready to submit: values trimmed, blanks dropped (an
 * optional field left empty is absent rather than an empty string), keys
 * sorted so two equivalent configurations compare equal as JSON.
 */
export function normalizeProviderConfig(
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const name of Object.keys(values).sort()) {
    const value = (values[name] ?? "").trim();
    if (value.length > 0) {
      normalized[name] = value;
    }
  }
  return normalized;
}

/**
 * The first reason this draft cannot be saved, as a sentence to show under
 * the form, or `null` when it is ready. The API validates the same things;
 * this only keeps the button honest before a round trip.
 */
export function providerFormError(
  fields: readonly ProviderField[],
  draft: ProviderDraft,
): string | null {
  const nameError = providerNameError(draft.label);
  if (nameError !== null) return nameError;
  if (!isHttpUrl(draft.baseUrl.trim())) {
    return "Enter the address as an http(s) URL, such as http://sftpgo:8080.";
  }
  for (const field of fields) {
    const value = (draft.config[field.name] ?? "").trim();
    if (field.required && value.length === 0) {
      return `Enter ${field.label.toLowerCase()}.`;
    }
    if (field.name === "homeTemplate" && value.length > 0 && !isPlausibleHomeTemplate(value)) {
      return 'The home template is written as "<root>:<path>".';
    }
  }
  return null;
}

/** Shared setup/edit validation uses the API's trimming and length limits. */
export function providerNameError(label: string): string | null {
  const parsed = ProviderName.safeParse(label);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Enter a storage name.");
}

/**
 * The patch for an edited provider: only the fields that actually changed,
 * so a form that only renames a row does not resend an address the API
 * would refuse. `addressEditable` is false for a row whose address is
 * pinned by environment or already used by a login.
 */
export function providerUpdatePatch(
  provider: AdminProvider,
  draft: ProviderDraft,
  addressEditable: boolean,
): AdminProviderUpdateRequest {
  const patch: AdminProviderUpdateRequest = {};
  const label = draft.label.trim();
  if (label !== provider.label) {
    patch.label = label;
  }
  const baseUrl = draft.baseUrl.trim();
  if (addressEditable && baseUrl !== provider.baseUrl) {
    patch.baseUrl = baseUrl;
  }
  const config = normalizeProviderConfig(draft.config);
  if (JSON.stringify(config) !== JSON.stringify(normalizeProviderConfig(provider.config))) {
    patch.config = config;
  }
  return patch;
}

/**
 * Why this provider's address cannot be edited here, or `null` when it can.
 * Mirrors the two refusals in the API's `update`: an env-pinned row, and a
 * row whose stored credentials are bound to the endpoint they were
 * verified against.
 */
export function providerAddressLock(provider: AdminProvider): string | null {
  if (provider.managedByEnv) {
    return "Set by the deployment. Remove SFTPGO_URL to manage the address here.";
  }
  if (provider.identityCount > 0) {
    return "Logins already use this server. Add a new provider for another address.";
  }
  return null;
}

/**
 * What the address field expects for a provider type: an example for the
 * placeholder and a one-line description. The S3 address carries the bucket
 * in its path, which people entering a bare endpoint would otherwise only
 * learn from the probe's refusal.
 */
export function providerAddressHint(type: string): { example: string; description: string } {
  switch (type) {
    case "s3":
      return {
        example: "https://s3.example.com/bucket",
        description:
          "The endpoint with the bucket in its path, such as https://s3.us-west-004.backblazeb2.com/media.",
      };
    case "webdav":
      return {
        example: "https://dav.example.com/",
        description: "The WebDAV URL people's files live under, such as https://dav.example.com/.",
      };
    default:
      return {
        example: "http://sftpgo:8080",
        description: "Where fdrive reaches this server, such as http://sftpgo:8080.",
      };
  }
}

/** Why this provider cannot be removed, or `null` when it can. */
export function providerRemoveBlock(provider: AdminProvider): string | null {
  if (provider.managedByEnv) {
    return "Set by the deployment. Remove SFTPGO_URL to manage this server here.";
  }
  if (provider.identityCount > 0) {
    return "Logins still use this server. Remove them first, or leave it disabled.";
  }
  return null;
}

/** The capabilities this provider type has, in a stable order, for the chips on a provider row. */
export function enabledCapabilities(capabilities: ProviderCapabilities): readonly CapabilityKey[] {
  return CAPABILITY_KEYS.filter((key) => capabilities[key]);
}

/** The capabilities this provider type lacks, in the same order, for the "Not available" chips. */
export function missingCapabilities(capabilities: ProviderCapabilities): readonly CapabilityKey[] {
  return CAPABILITY_KEYS.filter((key) => !capabilities[key]);
}
