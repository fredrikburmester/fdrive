import type { ProviderField, ProviderFieldValues, PublicProvider } from "@fdrive/contracts";

/**
 * The credential form shown when the provider list is unavailable (the API
 * is unreachable, or the account page's dialogs open before the list has
 * loaded): a username, a password and an optional one-time code. The server
 * validates against the real field list anyway.
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
 * signed in with: the secret ones (a password, a one-time code), never the
 * username the server already knows. The password field
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
 * The subtitle under "Sign in" on the login page: the storage's admin-set
 * name when it has one. Everyone signs in with an fdrive account.
 */
export function loginSubtitle(provider: Pick<PublicProvider, "label"> | undefined): string {
  return provider !== undefined && provider.label.length > 0
    ? `Sign in with your fdrive account on ${provider.label}`
    : "Sign in with your fdrive account";
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
