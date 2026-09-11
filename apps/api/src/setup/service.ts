import type { ConnectionTestResponse, SetupStatusResponse } from "@fdrive/contracts";
import { CoreError, parseHomeTemplate } from "@fdrive/core";
import type { AccountRepo, Provider, SettingsRepo } from "@fdrive/db";
import type { AuthService, LoginInput, LoginResult } from "../auth/service.js";
import { ApiHttpError } from "../errors.js";
import type { ProviderService } from "../providers/service.js";

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
  readonly providers: Pick<
    ProviderService,
    "list" | "enabled" | "create" | "update" | "remove" | "probe"
  >;
  readonly authService: Pick<AuthService, "loginCandidate" | "me" | "logout">;
  readonly accounts: Pick<AccountRepo, "setAdmin">;
  readonly settings: SettingsRepo;
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
    throw new ApiHttpError(
      "bad_request",
      err instanceof CoreError ? err.message : "invalid home template",
      err instanceof CoreError ? err.details : undefined,
    );
  }
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
 * Builds the `SetupService` backing `/api/v1/setup/*`: reports whether
 * setup is required, probes a candidate SFTPGo, and completes setup by
 * validating a candidate provider before it is enabled, then atomically
 * claiming its owner state before enabling the provider and marking that
 * account admin. The wizard creates SFTPGo providers only; other provider
 * types are added from System > Storage afterwards.
 */
export function createSetupService(deps: CreateSetupServiceDeps): SetupService {
  const { settings } = deps;
  const currentClaim = async () => parseOwnerState(await settings.get(SETUP_OWNER_KEY));
  const wasInitialized = async () => (await settings.get<boolean>(SETUP_INIT_KEY)) === true;

  async function envProvider(): Promise<Provider | null> {
    return (
      (await deps.providers.list()).find(
        (provider) => provider.managedByEnv && provider.type === "sftpgo",
      ) ?? null
    );
  }

  return {
    async status() {
      const claim = await currentClaim();
      if (claim === null && !(await wasInitialized())) {
        const configured = (await deps.providers.list()).some(
          (row) => row.enabled || row.managedByEnv,
        );
        if (configured) await settings.set(SETUP_INIT_KEY, true);
      }
      // Existing env/settings deployments predate the owner record. Treat an
      // already-enabled provider as complete so upgrades never lock users
      // into bootstrap. Fresh setup keeps the provider disabled until login.
      const required =
        claim?.state === "complete"
          ? false
          : claim?.state === "claiming"
            ? true
            : !(await wasInitialized());
      return { required, hasEnvUrl: deps.hasEnvUrl };
    },

    async test(baseUrl) {
      return deps.providers.probe({ type: "sftpgo", baseUrl });
    },

    async complete(input) {
      assertValidHomeTemplate(input.homeTemplate);

      const pinned = await envProvider();
      const baseUrl = pinned?.baseUrl ?? input.baseUrl;
      const probe = await deps.providers.probe({ type: "sftpgo", baseUrl });
      if (!probe.ok) {
        throw new ApiHttpError("bad_request", `SFTPGo is not reachable: ${probe.detail}`);
      }

      const existing =
        pinned ??
        (await deps.providers.list()).find(
          (provider) => provider.type === "sftpgo" && provider.baseUrl === baseUrl,
        ) ??
        null;
      // A row this call creates carries the template from the start; it is
      // disabled and removed again should the login fail. An existing row
      // (env-pinned, or found by address) is left untouched until the login
      // has been verified and the claim taken: a wrong password must not
      // rewrite a live provider's configuration. The label stays empty so
      // the public login page names the product, not the host; admins see
      // the host until they set a name.
      const created =
        existing === null
          ? await deps.providers.create(
              {
                type: "sftpgo",
                label: "",
                baseUrl,
                config: { homeTemplate: input.homeTemplate },
              },
              { enabled: false },
            )
          : null;
      const candidate = existing ?? (created as Provider);

      const loginInput: LoginInput = {
        providerId: candidate.id,
        credential: {
          username: input.username,
          password: input.password,
          ...(input.otp !== undefined ? { otp: input.otp } : {}),
        },
        userAgent: input.userAgent,
        ip: input.ip,
      };
      let loginResult: LoginResult;
      try {
        // Claim ownership in the same transaction as login persistence. A loser
        // rolls back its auth records before cleanup of any provider created here.
        loginResult = await deps.authService.loginCandidate(
          loginInput,
          candidate.id,
          SETUP_OWNER_KEY,
        );
      } catch (error) {
        if (created !== null) {
          await deps.providers.remove(created.id).catch(() => undefined);
        }
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

        // A crash after the claim is recoverable: the same verified identity
        // resumes the pending claim, while another process cannot overwrite it.
        await deps.providers.update(candidate.id, {
          ...(existing === null
            ? {}
            : { config: { ...stringConfig(existing.config), homeTemplate: input.homeTemplate } }),
          enabled: true,
        });

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

function stringConfig(config: Readonly<Record<string, unknown>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}
