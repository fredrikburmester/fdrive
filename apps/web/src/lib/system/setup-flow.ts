import { isHttpUrl } from "@fdrive/contracts";

/** The setup wizard's steps, in order. */
export const SETUP_STEPS = ["token", "connection", "account"] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/** The step after `step`, or null when `step` is the last one. */
export function nextSetupStep(step: SetupStep): SetupStep | null {
  const index = SETUP_STEPS.indexOf(step);
  const next = SETUP_STEPS[index + 1];
  return next ?? null;
}

/** The step before `step`, or null when `step` is the first one. */
export function previousSetupStep(step: SetupStep): SetupStep | null {
  const index = SETUP_STEPS.indexOf(step);
  const previous = index > 0 ? SETUP_STEPS[index - 1] : undefined;
  return previous ?? null;
}

export interface ConnectionTestState {
  readonly ok: boolean;
  readonly detail: string;
}

/** True once the setup token step has something to submit. */
export function canLeaveTokenStep(token: string): boolean {
  return token.trim().length > 0;
}

/**
 * True once the connection step has a plausible base URL and a passing
 * test result for that exact URL (a stale pass for a since-edited URL does
 * not count).
 */
export function canLeaveConnectionStep(
  baseUrl: string,
  testResult: ConnectionTestState | null,
  testedBaseUrl: string | null,
): boolean {
  return isHttpUrl(baseUrl) && testResult?.ok === true && testedBaseUrl === baseUrl;
}

/** True once the account step has both a username and a password. */
export function canCompleteAccountStep(username: string, password: string): boolean {
  return username.trim().length > 0 && password.length > 0;
}
