import type {
  ConnectionTestResponse,
  SetupCompleteRequest,
  SetupStatusResponse,
  SetupTestRequest,
} from "@fdrive/contracts";
import type { AccountRepo, Provider, SettingsRepo } from "@fdrive/db";
import type { AuthService, LoginInput, LoginResult } from "../auth/service.js";
import { ApiHttpError } from "../errors.js";
import type { LocalUserService } from "../local/service.js";
import type { ProviderService } from "../providers/service.js";

export type SetupCompleteInput = SetupCompleteRequest & {
  readonly userAgent: string | null;
  readonly ip: string;
};

export interface SetupService {
  status(): Promise<SetupStatusResponse>;
  test(request: SetupTestRequest): Promise<ConnectionTestResponse>;
  complete(input: SetupCompleteInput): Promise<LoginResult>;
}

export interface CreateSetupServiceDeps {
  readonly providers: Pick<
    ProviderService,
    "list" | "create" | "update" | "remove" | "probe" | "types"
  >;
  readonly authService: Pick<AuthService, "loginCandidate" | "me" | "logout">;
  readonly accounts: Pick<AccountRepo, "setAdmin">;
  readonly settings: SettingsRepo;
  /**
   * The deployment's local folder: its pinned provider row and how to count
   * and create its users. Absent when `FDRIVE_STORAGE_ROOT` is not set, and
   * setup connects WebDAV or S3 instead.
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

/** The login and the provider it is checked against, as one setup attempt prepares them. */
interface Candidate {
  readonly provider: Provider;
  readonly credential: Readonly<Record<string, string>>;
  /** Undoes what preparing the candidate created, when its login fails. */
  readonly discard: () => Promise<void>;
  /** Applied once the claim is taken: enables a provider this setup created. */
  readonly enable: () => Promise<void>;
}

/**
 * Builds the `SetupService` backing `/api/v1/setup/*`: reports whether setup
 * is required and how it goes, probes a candidate storage, and completes
 * setup by verifying the first login, then atomically claiming its owner
 * state before enabling anything and marking that account admin.
 *
 * With a local folder the owner picks a username and password, which
 * become the first local user. Without one the owner connects WebDAV or S3
 * and signs in to it; that provider stays disabled until the claim is taken.
 */
export function createSetupService(deps: CreateSetupServiceDeps): SetupService {
  const { settings } = deps;
  const currentClaim = async () => parseOwnerState(await settings.get(SETUP_OWNER_KEY));
  const wasInitialized = async () => (await settings.get<boolean>(SETUP_INIT_KEY)) === true;

  /**
   * Installations from before the owner record are complete when someone can
   * already sign in: a local user exists, or an administrator enabled a
   * provider. A row the deployment pins does not count, since a fresh
   * install has one before anyone has an account.
   */
  async function alreadyInUse(): Promise<boolean> {
    if (deps.local !== undefined && (await deps.local.userCount()) > 0) return true;
    return (await deps.providers.list()).some((row) => row.enabled && !row.managedByEnv);
  }

  async function localCandidate(username: string, password: string): Promise<Candidate> {
    const provider = await deps.local?.provider();
    if (deps.local === undefined || provider === null || provider === undefined) {
      throw new ApiHttpError("bad_request", "this deployment serves no local folder");
    }
    const discard = await deps.local.users.createOwner(username, password);
    return {
      provider,
      credential: { username, password },
      discard,
      enable: async () => {},
    };
  }

  async function providerCandidate(
    input: Extract<SetupCompleteRequest, { kind: "provider" }>,
  ): Promise<Candidate> {
    if (deps.local !== undefined) {
      throw new ApiHttpError("bad_request", "this deployment sets up its local folder");
    }
    const probe = await deps.providers.probe({
      type: input.type,
      baseUrl: input.baseUrl,
      ...(input.config === undefined ? {} : { config: input.config }),
    });
    if (!probe.ok) {
      throw new ApiHttpError("bad_request", `The storage is not reachable: ${probe.detail}`);
    }
    // A row found by address is left alone until the claim is taken: a wrong
    // password must not rewrite a live provider. A row this call creates is
    // disabled, and removed again should the login fail.
    const existing =
      (await deps.providers.list()).find(
        (row) => row.type === input.type && row.baseUrl === input.baseUrl,
      ) ?? null;
    const provider =
      existing ??
      (await deps.providers.create(
        {
          type: input.type,
          label: input.label?.trim() ?? "",
          baseUrl: input.baseUrl,
          ...(input.config === undefined ? {} : { config: input.config }),
        },
        { enabled: false },
      ));
    return {
      provider,
      credential: input.credential,
      discard: async () => {
        if (existing === null) await deps.providers.remove(provider.id).catch(() => undefined);
      },
      enable: async () => {
        await deps.providers.update(provider.id, {
          ...(input.label === undefined ? {} : { label: input.label.trim() }),
          enabled: true,
        });
      },
    };
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
      return deps.local === undefined
        ? { required, mode: "provider", types: required ? deps.providers.types() : [] }
        : { required, mode: "local", types: [] };
    },

    async test(request) {
      return deps.providers.probe({
        type: request.type,
        baseUrl: request.baseUrl,
        ...(request.config === undefined ? {} : { config: request.config }),
      });
    },

    async complete(input) {
      const candidate =
        input.kind === "local"
          ? await localCandidate(input.username, input.password)
          : await providerCandidate(input);
      const baseUrl = candidate.provider.baseUrl;

      const loginInput: LoginInput = {
        providerId: candidate.provider.id,
        credential: candidate.credential,
        userAgent: input.userAgent,
        ip: input.ip,
      };
      let loginResult: LoginResult;
      try {
        // Claim ownership in the same transaction as login persistence. A loser
        // rolls back its auth records before what the candidate created is undone.
        loginResult = await deps.authService.loginCandidate(
          loginInput,
          candidate.provider.id,
          SETUP_OWNER_KEY,
        );
      } catch (error) {
        await candidate.discard();
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
        await candidate.enable();
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
