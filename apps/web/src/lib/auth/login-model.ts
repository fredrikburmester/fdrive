import type { ProviderField, ProviderFieldValues, PublicProvider } from "@fdrive/contracts";
import { providerTypeLabel } from "@/lib/identity/provider-type";

/**
 * The credential form shown when the provider list is unavailable (the API
 * is unreachable, or the account page's dialogs open before the list has
 * loaded): SFTPGo's fields, which are also what every provider so far
 * asks for. The server validates against the real field list anyway.
 */
export const DEFAULT_CREDENTIAL_FIELDS: readonly ProviderField[] = [
  { name: "username", label: "Username", kind: "text", required: true, maxLength: 255 },
  { name: "password", label: "Password", kind: "password", required: true },
  {
    name: "otp",
    label: "One-time code",
    kind: "otp",
    required: false,
    transient: true,
    help: "Only when your login uses two-factor authentication.",
  },
];

/** The fields of `provider`, or the defaults when none is known. */
export function credentialFieldsFor(
  provider: PublicProvider | undefined,
): readonly ProviderField[] {
  return provider?.credentialFields ?? DEFAULT_CREDENTIAL_FIELDS;
}

/**
 * The fields a person re-enters to confirm they hold the login they are
 * signed in with: the secret ones (a password, a one-time code), never a
 * username or access key id the server already knows. The password field
 * stays required; a code stays optional. Labels and help are rewritten to
 * say whose credential this is, so "Password" does not read as the new
 * login's password next to it in the Add login dialog.
 */
export function confirmationFieldsFor(fields: readonly ProviderField[]): readonly ProviderField[] {
  return fields
    .filter((field) => field.kind === "password" || field.kind === "otp")
    .map((field) =>
      field.kind === "password"
        ? {
            ...field,
            label: "Your current password",
            help: "The password of the login you are signed in with, to confirm this change.",
          }
        : {
            ...field,
            label: "Your one-time code",
            help: "Optional. Enter it if your current login uses two-factor authentication.",
          },
    );
}

/**
 * What to call a provider in front of someone who is not signed in: the
 * name an admin gave it, else the product name. The public list never
 * carries the host, so there is nothing else to fall back to.
 */
export function providerDisplayName(provider: Pick<PublicProvider, "type" | "label">): string {
  return provider.label.length > 0 ? provider.label : providerTypeLabel(provider.type);
}

/** The subtitle under "Sign in" on the login page. */
export function loginSubtitle(providers: readonly PublicProvider[]): string {
  const [only] = providers;
  if (providers.length === 1 && only !== undefined) {
    const product = providerTypeLabel(only.type);
    return only.label.length > 0
      ? `Sign in with your ${product} account on ${only.label}`
      : `Sign in with your ${product} account`;
  }
  if (providers.length > 1) {
    return "Choose a server and sign in";
  }
  return "Sign in with your account";
}

/** The submitted values for `fields`: every filled field, with blank optional ones left out. */
export function buildCredential(
  fields: readonly ProviderField[],
  values: Readonly<Record<string, string>>,
): ProviderFieldValues {
  const credential: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name] ?? "";
    if (value.length > 0 || field.required) credential[field.name] = value;
  }
  return credential;
}

/** True once every required field has a value. */
export function credentialComplete(
  fields: readonly ProviderField[],
  values: Readonly<Record<string, string>>,
): boolean {
  return fields.every((field) => !field.required || (values[field.name] ?? "").length > 0);
}

/** Picks the provider `id` names, else the first one; `undefined` when there is none. */
export function selectProvider(
  providers: readonly PublicProvider[],
  id: string | null,
): PublicProvider | undefined {
  return providers.find((provider) => provider.id === id) ?? providers[0];
}
