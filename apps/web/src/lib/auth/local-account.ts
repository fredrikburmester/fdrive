import { LocalPassword, LocalUsername } from "@fdrive/contracts";

/** The schema's own wording for a refused value. */
function issueText(issues: readonly { readonly message: string }[]): string {
  return issues.map((issue) => issue.message).join(" ");
}

/**
 * Why `value` cannot be a local username, or `null` when it can. The same
 * rules the API applies: the name is also the user's home folder.
 */
export function localUsernameError(value: string): string | null {
  if (value.trim().length === 0) return "Enter a username.";
  const parsed = LocalUsername.safeParse(value);
  return parsed.success ? null : issueText(parsed.error.issues);
}

/** Why `value` cannot be a local password, or `null` when it can. */
export function localPasswordError(value: string): string | null {
  const parsed = LocalPassword.safeParse(value);
  return parsed.success ? null : issueText(parsed.error.issues);
}

/** Why the repeated password does not confirm the new one, or `null` when it does. */
export function passwordConfirmError(password: string, confirm: string): string | null {
  return password === confirm ? null : "The passwords don't match.";
}

/** A new password typed twice, as the account and setup forms collect it. */
export interface NewPasswordDraft {
  readonly password: string;
  readonly confirm: string;
}

/**
 * The errors to show under a new-password pair: each only once its field
 * holds something, so an empty form is not red before anyone types.
 * `valid` is true once both are filled, the password passes the rules and
 * the repeat matches.
 */
export function newPasswordErrors(draft: NewPasswordDraft): {
  readonly password: string | null;
  readonly confirm: string | null;
  readonly valid: boolean;
} {
  const password = localPasswordError(draft.password);
  const confirm = passwordConfirmError(draft.password, draft.confirm);
  return {
    password: draft.password.length > 0 ? password : null,
    confirm: draft.confirm.length > 0 ? confirm : null,
    valid: password === null && confirm === null,
  };
}
