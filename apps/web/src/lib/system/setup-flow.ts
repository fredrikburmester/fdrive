export type SetupStep = "token" | "account";

/**
 * The setup wizard's steps, in order: claim the installation with its
 * token, then create the owner's account on the deployment's files folder.
 */
export const SETUP_STEPS: readonly SetupStep[] = ["token", "account"];

/** The step after `step`, or null when `step` is the last one. */
export function nextSetupStep(step: SetupStep): SetupStep | null {
  return SETUP_STEPS[SETUP_STEPS.indexOf(step) + 1] ?? null;
}

/** The step before `step`, or null when `step` is the first one. */
export function previousSetupStep(step: SetupStep): SetupStep | null {
  const index = SETUP_STEPS.indexOf(step);
  return index > 0 ? (SETUP_STEPS[index - 1] as SetupStep) : null;
}

/** True once the setup token step has something to submit. */
export function canLeaveTokenStep(token: string): boolean {
  return token.trim().length > 0;
}
