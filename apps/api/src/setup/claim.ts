import type { SettingsRepo } from "@fdrive/db";

/** Persistent setup-owner record. Kept separate from the connection so an
 * interrupted owner login never makes a connection look configured. */
export const SETUP_OWNER_SETTINGS_KEY = "setup.owner.v1";

export interface PendingSetupOwner {
  readonly version: 1;
  readonly state: "claiming";
  readonly accountId: string;
  readonly baseUrl: string;
}

export interface CompletedSetupOwner {
  readonly version: 1;
  readonly state: "complete";
  readonly accountId: string;
  readonly baseUrl: string;
}

export type SetupOwnerState = PendingSetupOwner | CompletedSetupOwner;

export interface SetupClaimStore {
  current(): Promise<SetupOwnerState | null>;
  wasInitialized(): Promise<boolean>;
  markInitialized(): Promise<void>;
  /** Creates the durable single-owner claim, or resumes the same claimant. */
  claim(input: { accountId: string; baseUrl: string }): Promise<"claimed" | "resumed" | "taken">;
  /** Marks only the currently-pending owner as complete. */
  finalize(input: { accountId: string; baseUrl: string }): Promise<boolean>;
}

function parseState(value: unknown): SetupOwnerState | null {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { accountId?: unknown }).accountId !== "string" ||
    typeof (value as { baseUrl?: unknown }).baseUrl !== "string"
  ) {
    return null;
  }
  const state = (value as { state?: unknown }).state;
  if (state !== "claiming" && state !== "complete") return null;
  return value as SetupOwnerState;
}

/**
 * Cross-process owner claim store. `SettingsRepo.compareAndSet` maps to a
 * single SQL statement, so two API processes cannot both become owner.
 */
export function createSetupClaimStore(settings: SettingsRepo): SetupClaimStore {
  return {
    async wasInitialized() {
      return (await settings.get<boolean>("setup.initialized.v1")) === true;
    },
    async markInitialized() {
      await settings.set("setup.initialized.v1", true);
    },
    async current() {
      return parseState(await settings.get<unknown>(SETUP_OWNER_SETTINGS_KEY));
    },
    async claim(input) {
      const desired: PendingSetupOwner = { version: 1, state: "claiming", ...input };
      if (await settings.compareAndSet(SETUP_OWNER_SETTINGS_KEY, null, desired)) return "claimed";

      const existing = await this.current();
      if (
        existing?.state === "claiming" &&
        existing.accountId === input.accountId &&
        existing.baseUrl === input.baseUrl
      ) {
        return "resumed";
      }
      return "taken";
    },
    async finalize(input) {
      const pending: PendingSetupOwner = { version: 1, state: "claiming", ...input };
      const complete: CompletedSetupOwner = { version: 1, state: "complete", ...input };
      return settings.compareAndSet(SETUP_OWNER_SETTINGS_KEY, pending, complete);
    },
  };
}
