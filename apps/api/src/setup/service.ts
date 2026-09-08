import type { ConnectionTestResponse, SetupStatusResponse } from "@fdrive/contracts";
import { CoreError, parseHomeTemplate } from "@fdrive/core";
import type { AccountRepo } from "@fdrive/db";
import type { AuthService, LoginInput, LoginResult } from "../auth/service.js";
import { probeConnection } from "../connection/probe.js";
import type { ConnectionStore } from "../connection/store.js";
import { ApiHttpError } from "../errors.js";
import type { SetupClaimStore } from "./claim.js";

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
  readonly authService: Pick<AuthService, "loginCandidate" | "me">;
  readonly accounts: Pick<AccountRepo, "setAdmin">;
  readonly claims: SetupClaimStore;
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
 * validating a candidate before it is active, then atomically claiming its
 * owner state before storing the connection and marking that account admin.
 */
export function createSetupService(deps: CreateSetupServiceDeps): SetupService {
  return {
    async status() {
      const connection = await deps.connectionStore.current();
      const claim = await deps.claims.current();
      // Existing env/settings deployments predate the owner record. Treat an
      // already-active connection as complete so upgrades never lock users
      // into bootstrap. Fresh setup keeps the connection absent until login.
      const required =
        claim?.state === "complete"
          ? false
          : claim?.state === "claiming"
            ? true
            : connection === null;
      return { required, hasEnvUrl: deps.hasEnvUrl };
    },

    async test(baseUrl) {
      return probeConnection(baseUrl, { fetch: deps.fetch });
    },

    async complete(input) {
      assertValidHomeTemplate(input.homeTemplate);

      const active = await deps.connectionStore.current();
      const candidateBaseUrl = active?.source === "env" ? active.baseUrl : input.baseUrl;
      const probe = await probeConnection(candidateBaseUrl, { fetch: deps.fetch });
      if (!probe.ok) {
        throw new ApiHttpError("bad_request", `SFTPGo is not reachable: ${probe.detail}`);
      }

      const loginInput: LoginInput = {
        username: input.username,
        password: input.password,
        ...(input.otp !== undefined ? { otp: input.otp } : {}),
        userAgent: input.userAgent,
        ip: input.ip,
      };
      // This performs upstream authentication and provider-bound credential
      // creation against the candidate URL, without making it active.
      const loginResult = await deps.authService.loginCandidate(loginInput, candidateBaseUrl);

      const claim = await deps.claims.claim({
        accountId: loginResult.me.account.id,
        baseUrl: candidateBaseUrl,
      });
      if (claim === "taken") {
        throw new ApiHttpError("conflict", "this server has already been claimed by another owner");
      }

      // A crash after the claim is recoverable: the same verified identity
      // resumes the pending claim, while another process cannot overwrite it.
      await deps.connectionStore.update({
        ...(active?.source === "env" ? {} : { baseUrl: candidateBaseUrl }),
        homeTemplate: input.homeTemplate,
      });

      await deps.accounts.setAdmin(loginResult.me.account.id, true);
      if (
        !(await deps.claims.finalize({
          accountId: loginResult.me.account.id,
          baseUrl: candidateBaseUrl,
        }))
      ) {
        throw new ApiHttpError("conflict", "setup ownership changed; retry setup login");
      }
      const me = await deps.authService.me(
        loginResult.me.account.id,
        loginResult.me.activeIdentityId,
      );

      return { sessionId: loginResult.sessionId, me };
    },
  };
}
