import type { ConnectionTestResponse, SetupStatusResponse } from "@fdrive/contracts";
import { CoreError, parseHomeTemplate } from "@fdrive/core";
import type { AccountRepo } from "@fdrive/db";
import type { AuthService, LoginInput, LoginResult } from "../auth/service.js";
import { probeConnection } from "../connection/probe.js";
import type { ConnectionStore } from "../connection/store.js";
import { ApiHttpError } from "../errors.js";

export interface SetupCompleteInput {
  readonly baseUrl: string;
  readonly homeTemplate: string;
  readonly username: string;
  readonly password: string;
  readonly otp?: string;
  readonly userAgent: string | null;
  readonly ip: string;
}

export interface SetupService {
  status(): Promise<SetupStatusResponse>;
  test(baseUrl: string): Promise<ConnectionTestResponse>;
  complete(input: SetupCompleteInput): Promise<LoginResult>;
}

export interface CreateSetupServiceDeps {
  readonly connectionStore: ConnectionStore;
  readonly authService: Pick<AuthService, "login" | "me">;
  readonly accounts: Pick<AccountRepo, "setAdmin">;
  readonly fetch: typeof globalThis.fetch;
  /** Whether `SFTPGO_URL` is set by environment; surfaced on `status()` for the setup UI. */
  readonly hasEnvUrl: boolean;
}

/**
 * Turns a `homeTemplate` string into an `ApiHttpError("bad_request", ...)`
 * when it does not parse, otherwise resolves without a value: `complete`
 * only needs the validation, not the parsed template, since the raw
 * string is what gets stored.
 */
function assertValidHomeTemplate(homeTemplate: string): void {
  try {
    parseHomeTemplate(homeTemplate);
  } catch (err) {
    if (err instanceof CoreError) {
      throw new ApiHttpError("bad_request", err.message, err.details);
    }
    throw err;
  }
}

/**
 * Builds the `SetupService` backing `/api/v1/setup/*`: reports whether
 * setup is required, probes a candidate SFTPGo, and completes setup by
 * storing the connection, running the normal login flow against it, and
 * marking the resulting account an admin.
 */
export function createSetupService(deps: CreateSetupServiceDeps): SetupService {
  return {
    async status() {
      const connection = await deps.connectionStore.current();
      return { required: connection === null, hasEnvUrl: deps.hasEnvUrl };
    },

    async test(baseUrl) {
      return probeConnection(baseUrl, { fetch: deps.fetch });
    },

    async complete(input) {
      assertValidHomeTemplate(input.homeTemplate);

      const probe = await probeConnection(input.baseUrl, { fetch: deps.fetch });
      if (!probe.ok) {
        throw new ApiHttpError("bad_request", `SFTPGo is not reachable: ${probe.detail}`);
      }

      await deps.connectionStore.update({
        baseUrl: input.baseUrl,
        homeTemplate: input.homeTemplate,
      });

      const loginInput: LoginInput = {
        username: input.username,
        password: input.password,
        ...(input.otp !== undefined ? { otp: input.otp } : {}),
        userAgent: input.userAgent,
        ip: input.ip,
      };
      const loginResult = await deps.authService.login(loginInput);

      await deps.accounts.setAdmin(loginResult.me.account.id, true);
      const me = await deps.authService.me(
        loginResult.me.account.id,
        loginResult.me.activeIdentityId,
      );

      return { sessionId: loginResult.sessionId, me };
    },
  };
}
