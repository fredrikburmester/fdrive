import type { SetupCompleteRequest, SetupStatusResponse } from "@fdrive/contracts";
import type { AccountRepo, Provider, SettingsRepo } from "@fdrive/db";
import type { AuthService, LoginInput, LoginResult } from "../auth/service.js";
import { ApiHttpError } from "../errors.js";
import type { LocalUserService } from "../local/service.js";

export type SetupCompleteInput = SetupCompleteRequest & {
  readonly userAgent: string | null;
  readonly ip: string;
};

export interface SetupService {
  status(): Promise<SetupStatusResponse>;
  complete(input: SetupCompleteInput): Promise<LoginResult>;
}

export interface CreateSetupServiceDeps {
  readonly authService: Pick<AuthService, "loginCandidate" | "me" | "logout">;
  readonly accounts: Pick<AccountRepo, "setAdmin">;
  readonly settings: SettingsRepo;
  /**
   * The deployment's files folder: its pinned provider row and how to count
   * and create its users. Absent when `FDRIVE_STORAGE_ROOT` is not set: the
   * deployment has no storage, and setup cannot finish.
   */
  readonly local?: {
    readonly provider: () => Promise<Provider | null>;
    readonly userCount: () => Promise<number>;
    readonly users: Pick<LocalUserService, "createOwner">;
  };
}

const SETUP_OWNER_KEY = "setup.owner.v1";
const SETUP_INIT_KEY = "setup.initialized.v1";

interface SetupOwnerState {
  readonly version: 1;
  readonly state: "claiming" | "complete";
  readonly accountId: string;
  readonly baseUrl: string;
}

function parseOwnerState(value: unknown): SetupOwnerState | null {
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
  return state === "claiming" || state === "complete" ? (value as SetupOwnerState) : null;
}

/**
 * Builds the `SetupService` backing `/api/v1/setup/*`: reports whether setup
 * is required and whether the deployment has a files folder, and completes
 * setup. The owner picks a username and password, which become the first
 * local user; setup verifies that login, then atomically claims its owner
 * state before marking the account admin.
 */
export function createSetupService(deps: CreateSetupServiceDeps): SetupService {
  const { settings } = deps;
  const currentClaim = async () => parseOwnerState(await settings.get(SETUP_OWNER_KEY));
  const wasInitialized = async () => (await settings.get<boolean>(SETUP_INIT_KEY)) === true;

  /**
   * Installations from before the owner record are complete when someone can
   * already sign in: a local user exists.
   */
  async function alreadyInUse(): Promise<boolean> {
    return deps.local !== undefined && (await deps.local.userCount()) > 0;
  }

  return {
    async status() {
      const claim = await currentClaim();
      if (claim === null && !(await wasInitialized()) && (await alreadyInUse())) {
        await settings.set(SETUP_INIT_KEY, true);
      }
      const required =
        claim?.state === "complete"
          ? false
          : claim?.state === "claiming"
            ? true
            : !(await wasInitialized());
      return { required, storageConfigured: deps.local !== undefined };
    },

    async complete(input) {
      const local = deps.local;
      const provider = (await local?.provider()) ?? null;
      if (local === undefined || provider === null) {
        throw new ApiHttpError(
          "bad_request",
          "this deployment has no files folder: set FDRIVE_STORAGE_ROOT and restart fdrive",
        );
      }
      const baseUrl = provider.baseUrl;
      // The owner's local user is removed again should the login fail.
      const discard = await local.users.createOwner(input.username, input.password);

      const loginInput: LoginInput = {
        providerId: provider.id,
        credential: { username: input.username, password: input.password },
        userAgent: input.userAgent,
        ip: input.ip,
      };
      let loginResult: LoginResult;
      try {
        // Claim ownership in the same transaction as login persistence. A loser
        // rolls back its auth records before its local user is removed.
        loginResult = await deps.authService.loginCandidate(
          loginInput,
          provider.id,
          SETUP_OWNER_KEY,
        );
      } catch (error) {
        await discard();
        throw error;
      }

      try {
        const ownerInput = { accountId: loginResult.me.account.id, baseUrl };
        const desiredClaim: SetupOwnerState = { version: 1, state: "claiming", ...ownerInput };
        const claimed = await settings.compareAndSet(SETUP_OWNER_KEY, null, desiredClaim);
        if (!claimed) {
          const existingClaim = await currentClaim();
          const isResumed =
            existingClaim?.state === "claiming" &&
            existingClaim.accountId === ownerInput.accountId &&
            existingClaim.baseUrl === ownerInput.baseUrl;
          if (!isResumed) {
            throw new ApiHttpError(
              "conflict",
              "this server has already been claimed by another owner",
            );
          }
        }

        // A crash after the claim is recoverable: the same verified login
        // resumes the pending claim, while another process cannot overwrite it.
        await deps.accounts.setAdmin(loginResult.me.account.id, true);
        const finalized = await settings.compareAndSet(SETUP_OWNER_KEY, desiredClaim, {
          version: 1,
          state: "complete",
          ...ownerInput,
        });
        if (!finalized) {
          throw new ApiHttpError("conflict", "setup ownership changed; retry setup login");
        }
        const me = await deps.authService.me(
          loginResult.me.account.id,
          loginResult.me.activeIdentityId,
        );

        return { sessionId: loginResult.sessionId, me };
      } catch (error) {
        // Discard this request's session while preserving resumable ownership.
        await deps.authService.logout(loginResult.sessionId).catch(() => undefined);
        throw error;
      }
    },
  };
}
