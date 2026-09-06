import type { ApiTokenExpiresInDays } from "@fdrive/contracts";

/** One choice in the "create token" dialog's expiry `Select`. */
export interface ExpiryOption {
  readonly value: string;
  readonly label: string;
  readonly days: ApiTokenExpiresInDays | undefined;
}

/** The expiry choices offered when creating a token: 30/90/365 days, or never. */
export const EXPIRY_OPTIONS: readonly ExpiryOption[] = [
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "365 days", days: 365 },
  { value: "never", label: "Never", days: undefined },
];

/** The default expiry option value, shown selected when the create dialog opens. */
export const DEFAULT_EXPIRY_OPTION_VALUE = "90";

/**
 * Maps an `ExpiryOption.value` (a `Select`'s string value) to the
 * `expiresInDays` the create-token request body expects, `undefined` for
 * "never" or an unrecognized value.
 */
export function expiresInDaysFromOptionValue(value: string): ApiTokenExpiresInDays | undefined {
  return EXPIRY_OPTIONS.find((option) => option.value === value)?.days;
}
