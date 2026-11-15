import type { SetupCompleteRequest, SetupStatusResponse } from "@fdrive/contracts";
import { ConflictError, LoginError, type LoginRepo, type Provider } from "@fdrive/db";
import type { AuthService, LoginResult } from "../auth/service.js";
import { ApiHttpError } from "../errors.js";
import type { SharePasswords } from "../shares/passwords.js";

export type SetupCompleteInput = SetupCompleteRequest & {
  readonly userAgent: string | null;
  readonly ip: string;
};

export interface SetupService {
  status(): Promise<SetupStatusResponse>;
  complete(input: SetupCompleteInput): Promise<LoginResult>;
}

export interface CreateSetupServiceDeps {
  readonly authService: Pick<AuthService, "login">;
  readonly logins: Pick<LoginRepo, "setup" | "setupOpen">;
  readonly passwords: Pick<SharePasswords, "hash">;
  readonly clock?: () => Date;
  /**
   * The deployment's files folder's pinned provider row. Absent when
   * `FDRIVE_STORAGE_ROOT` is not set: the deployment has no storage, and
   * setup cannot finish.
   */
  readonly localProvider?: () => Promise<Provider | null>;
}

/**
 * Builds the `SetupService` backing `/api/v1/setup/*`: reports whether setup
 * is required and whether the deployment has a files folder, and completes
 * setup. Setup is open only on a fresh install (no owner record, user,
 * account or login), so once anyone has used fdrive it never reopens. The
 * owner picks a username and password; one locked transaction checks the
 * install is still fresh, creates them as the first local user, an
 * administrator, with a new account and login, and records them as the
 * owner. They are then signed in like anyone else.
 */
export function createSetupService(deps: CreateSetupServiceDeps): SetupService {
  const clock = deps.clock ?? (() => new Date());

  return {
    async status() {
      return {
        required: await deps.logins.setupOpen(),
        storageConfigured: deps.localProvider !== undefined,
      };
    },

    async complete(input) {
      const provider = (await deps.localProvider?.()) ?? null;
      if (provider === null) {
        throw new ApiHttpError(
          "bad_request",
          "this deployment has no files folder: set FDRIVE_STORAGE_ROOT and restart fdrive",
        );
      }
      try {
        await deps.logins.setup({
          providerId: provider.id,
          username: input.username,
          passwordHash: await deps.passwords.hash(input.password),
          at: clock(),
        });
      } catch (error) {
        if (error instanceof LoginError && error.code === "setup_claimed") {
          throw new ApiHttpError(
            "conflict",
            "this server has already been claimed by another owner",
          );
        }
        if (error instanceof ConflictError) {
          throw new ApiHttpError("conflict", "a user with this name already exists");
        }
        throw error;
      }
      return deps.authService.login({
        username: input.username,
        password: input.password,
        userAgent: input.userAgent,
        ip: input.ip,
      });
    },
  };
}
