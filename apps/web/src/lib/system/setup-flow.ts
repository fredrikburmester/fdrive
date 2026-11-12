import type { ProviderField, SetupMode } from "@fdrive/contracts";
import { normalizeProviderConfig, providerFormError } from "./connection";

export type SetupStep = "token" | "connection" | "account";

/**
 * The setup wizard's steps per mode, in order. A deployment with a local
 * folder only needs the owner's account; without one, the owner first
 * connects the storage they will sign in to.
 */
export const SETUP_STEPS: Readonly<Record<SetupMode, readonly SetupStep[]>> = {
  local: ["token", "account"],
  provider: ["token", "connection", "account"],
};

/** The step after `step` in `mode`, or null when `step` is the last one. */
export function nextSetupStep(mode: SetupMode, step: SetupStep): SetupStep | null {
  const steps = SETUP_STEPS[mode];
  return steps[steps.indexOf(step) + 1] ?? null;
}

/** The step before `step` in `mode`, or null when `step` is the first one. */
export function previousSetupStep(mode: SetupMode, step: SetupStep): SetupStep | null {
  const steps = SETUP_STEPS[mode];
  const index = steps.indexOf(step);
  return index > 0 ? (steps[index - 1] as SetupStep) : null;
}

export interface ConnectionTestState {
  readonly ok: boolean;
  readonly detail: string;
}

/** True once the setup token step has something to submit. */
export function canLeaveTokenStep(token: string): boolean {
  return token.trim().length > 0;
}

/** The storage the provider-mode connection step describes, as typed. */
export interface SetupConnectionDraft {
  readonly type: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly config: Readonly<Record<string, string>>;
}

/**
 * What a connection test proved reachable: the type, address and
 * configuration as they would be submitted. The name is left out, so
 * renaming the storage keeps a passing test.
 */
export function connectionTestKey(draft: SetupConnectionDraft): string {
  return JSON.stringify([draft.type, draft.baseUrl.trim(), normalizeProviderConfig(draft.config)]);
}

/** The first reason the connection step's form is incomplete, or null when it can be tested. */
export function connectionStepError(
  fields: readonly ProviderField[],
  draft: SetupConnectionDraft,
): string | null {
  if (draft.type.length === 0) return "Choose a storage type.";
  return providerFormError(fields, draft);
}

/**
 * True once the connection step's form is complete and a passing test
 * result belongs to exactly what is typed now: a pass for an address or
 * configuration edited since does not count.
 */
export function canLeaveConnectionStep(
  fields: readonly ProviderField[],
  draft: SetupConnectionDraft,
  testResult: ConnectionTestState | null,
  testedKey: string | null,
): boolean {
  return (
    connectionStepError(fields, draft) === null &&
    testResult?.ok === true &&
    testedKey === connectionTestKey(draft)
  );
}
