import type { SetupCompleteRequest, SetupStatusResponse } from "@fdrive/contracts";
import { ConflictError, LoginError, type LoginRepo } from "@fdrive/db";
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
  /** The files folder's provider row, which the owner's login is on. */
  readonly storageId: string;
}

/**
 * Builds the `SetupService` backing `/api/v1/setup/*`: reports whether setup
 * is required, and completes setup. Setup is open only on a fresh install (no owner record, user,
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
      return { required: await deps.logins.setupOpen() };
    },

    async complete(input) {
      try {
        await deps.logins.setup({
          providerId: deps.storageId,
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
