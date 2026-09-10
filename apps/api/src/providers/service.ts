import type {
  AdminProvider,
  AdminProviderCreateRequest,
  AdminProviderTestRequest,
  AdminProviderType,
  AdminProviderUpdateRequest,
  ProviderCapabilities,
  PublicProvider,
} from "@fdrive/contracts";
import type { ProbeResult, ProviderInstance, ProviderModule } from "@fdrive/core";
import { validateFields } from "@fdrive/core";
import type { Identity, Provider, ProviderRepo, Repos } from "@fdrive/db";
import { ConflictError } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";
import { noopSystemEventLog, type SystemEventLog } from "../system/event-log.js";
import { isProviderType, PROVIDER_MODULES } from "./registry.js";

/** The settings key the single SFTPGo connection lived under before providers became rows. */
export const LEGACY_CONNECTION_SETTINGS_KEY = "connection.sftpgo";

/** A provider row with the module that implements it and the instance the module sees. */
export interface ResolvedProvider {
  readonly provider: Provider;
  readonly module: ProviderModule;
  readonly instance: ProviderInstance;
}

export interface IdentityProvider extends ResolvedProvider {
  readonly identity: Identity;
}

export interface ProviderServiceDeps {
  readonly repos: Pick<Repos, "providers" | "identities" | "settings">;
  readonly fetch: typeof globalThis.fetch;
  readonly clock: () => Date;
  readonly eventLog?: SystemEventLog;
  /** How `SFTPGO_URL` and `FDRIVE_HOME_TEMPLATE` seed and pin the first SFTPGo provider. */
  readonly environment: {
    readonly sftpgoUrl: string | undefined;
    readonly homeTemplate: string;
    readonly indexRootCount: number;
  };
  /** Whether the recycle folder is switched on for a provider (Trash settings). */
  readonly trashEnabled?: (providerId: string) => Promise<boolean>;
  /** Replaces the registry's modules by type; tests inject modules over shared fakes. */
  readonly modules?: Readonly<Record<string, ProviderModule>>;
}

export interface ProviderService {
  /** Every provider row, oldest first. */
  list(): Promise<Provider[]>;
  /** Enabled providers only, oldest first: what users may log in to. */
  enabled(): Promise<Provider[]>;
  /** The oldest enabled provider, or `null` before setup. */
  defaultProvider(): Promise<Provider | null>;
  /** The row, module and instance for `id`; `null` when it does not exist or its type is unknown. */
  get(id: string): Promise<ResolvedProvider | null>;
  /**
   * Like `get` but throws `upstream_unavailable` when the provider is
   * missing, disabled (unless `allowDisabled`) or of an unknown type.
   */
  resolve(id: string, opts?: { allowDisabled?: boolean }): Promise<ResolvedProvider>;
  /** The identity and its provider; `reauth_required` when the identity is gone. */
  forIdentity(identityId: string): Promise<IdentityProvider>;
  /** Validates and stores a new provider. Does not probe it. */
  create(
    input: AdminProviderCreateRequest,
    opts?: { enabled?: boolean; managedByEnv?: boolean },
  ): Promise<Provider>;
  update(id: string, patch: AdminProviderUpdateRequest): Promise<Provider>;
  remove(id: string): Promise<void>;
  /** Probes a saved provider by id or an unsaved candidate. */
  probe(target: string | AdminProviderTestRequest): Promise<ProbeResult>;
  capabilitiesFor(resolved: ResolvedProvider): Promise<ProviderCapabilities>;
  labelFor(provider: Provider): string;
  publicView(provider: Provider): PublicProvider | null;
  /** The admin view of a row, including a fresh reachability probe. */
  adminView(provider: Provider): Promise<AdminProvider | null>;
  types(): AdminProviderType[];
  /**
   * Runs once at startup: creates or pins the SFTPGo provider named by
   * `SFTPGO_URL`, folds the pre-row `connection.sftpgo` setting into a
   * provider row, and removes that setting. Idempotent.
   */
  seedFromEnvironment(): Promise<void>;
}

/** The host of a provider's endpoint, the label shown when an admin has set none. */
export function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function instanceOf(provider: Provider): ProviderInstance {
  return { id: provider.id, baseUrl: provider.baseUrl, config: provider.config };
}

function assertValidConfig(module: ProviderModule, config: unknown): Record<string, string> {
  const result = validateFields(module.configFields, config ?? {});
  if (!result.ok) {
    throw new ApiHttpError("bad_request", "invalid provider configuration", {
      issues: result.issues,
    });
  }
  return result.value;
}

interface StoredConnection {
  readonly baseUrl?: string;
  readonly homeTemplate?: string;
}

export function createProviderService(deps: ProviderServiceDeps): ProviderService {
  const eventLog = deps.eventLog ?? noopSystemEventLog;
  const repo: ProviderRepo = deps.repos.providers;
  const modules: Readonly<Record<string, ProviderModule>> = deps.modules ?? PROVIDER_MODULES;
  const moduleForType = (type: string): ProviderModule | null =>
    isProviderType(type) ? (modules[type] ?? null) : null;

  function requireModule(type: string): ProviderModule {
    const module = moduleForType(type);
    if (module === null) {
      throw new ApiHttpError("bad_request", `unknown provider type: ${type}`);
    }
    return module;
  }

  function resolved(provider: Provider): ResolvedProvider | null {
    const module = moduleForType(provider.type);
    return module === null ? null : { provider, module, instance: instanceOf(provider) };
  }

  async function get(id: string): Promise<ResolvedProvider | null> {
    const provider = await repo.get(id);
    return provider === null ? null : resolved(provider);
  }

  async function resolve(
    id: string,
    opts?: { allowDisabled?: boolean },
  ): Promise<ResolvedProvider> {
    const found = await get(id);
    if (found === null || (!found.provider.enabled && opts?.allowDisabled !== true)) {
      throw new ApiHttpError("upstream_unavailable", "storage provider unavailable");
    }
    return found;
  }

  async function requireProvider(id: string): Promise<Provider> {
    const provider = await repo.get(id);
    if (provider === null) {
      throw new ApiHttpError("not_found", "storage provider not found");
    }
    return provider;
  }

  const labelFor = (provider: Provider): string =>
    provider.label.length > 0 ? provider.label : hostLabel(provider.baseUrl);

  async function capabilitiesFor(target: ResolvedProvider): Promise<ProviderCapabilities> {
    const flags = target.module.capabilities;
    const hasRoots = deps.environment.indexRootCount > 0;
    const trashOn =
      target.module.trash !== "none" &&
      flags.trash &&
      ((await deps.trashEnabled?.(target.provider.id)) ?? false);
    return {
      zip: flags.zip,
      setModifiedAt: flags.setModifiedAt,
      atomicMove: flags.atomicMove,
      trash: trashOn,
      shares: flags.shares,
      office: flags.office,
      index: flags.index && hasRoots,
      scopeMapping: flags.scopeMapping && hasRoots,
    };
  }

  async function probeInstance(module: ProviderModule, instance: ProviderInstance) {
    return module.probe(instance, { fetch: deps.fetch });
  }

  return {
    list: () => repo.list(),
    async enabled() {
      return (await repo.list()).filter(
        (provider) => provider.enabled && moduleForType(provider.type) !== null,
      );
    },
    async defaultProvider() {
      const rows = await repo.list();
      return (
        rows.find((provider) => provider.enabled && moduleForType(provider.type) !== null) ?? null
      );
    },
    get,
    resolve,
    async forIdentity(identityId) {
      const identity = await deps.repos.identities.get(identityId);
      if (identity === null) {
        throw new ApiHttpError("reauth_required", "identity not found; sign in again");
      }
      const target = await resolve(identity.providerId);
      return { ...target, identity };
    },
    async create(input, opts) {
      const module = requireModule(input.type);
      const config = assertValidConfig(module, input.config);
      const existing = (await repo.list()).find(
        (provider) => provider.type === input.type && provider.baseUrl === input.baseUrl,
      );
      if (existing !== undefined) {
        throw new ApiHttpError("conflict", "a provider with this endpoint already exists");
      }
      const created = await repo.ensure({ type: input.type, baseUrl: input.baseUrl });
      const provider = await repo.update(created.id, {
        label: input.label,
        config,
        enabled: opts?.enabled ?? true,
        managedByEnv: opts?.managedByEnv ?? false,
      });
      if (provider === null) {
        throw new ApiHttpError("internal", "provider vanished while being created");
      }
      eventLog.record("general", "info", `Storage provider added: ${labelFor(provider)}`, {
        providerId: provider.id,
        type: provider.type,
      });
      return provider;
    },
    async update(id, patch) {
      const current = await requireProvider(id);
      const module = requireModule(current.type);
      if (patch.baseUrl !== undefined && patch.baseUrl !== current.baseUrl) {
        if (current.managedByEnv) {
          throw new ApiHttpError(
            "forbidden",
            "this provider's address is set by the deployment and cannot be changed here",
          );
        }
        // A stored credential must never follow a configuration change to a
        // different server: identities stay bound to the endpoint they were
        // verified against. Add a new provider instead.
        if ((await deps.repos.identities.countByProvider(id)) > 0) {
          throw new ApiHttpError(
            "conflict",
            "logins already use this provider; add a new provider for another address",
          );
        }
      }
      const config =
        patch.config === undefined ? undefined : assertValidConfig(module, patch.config);
      const updated = await repo.update(id, {
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
        ...(config !== undefined ? { config } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      });
      if (updated === null) {
        throw new ApiHttpError("not_found", "storage provider not found");
      }
      eventLog.record("general", "info", `Storage provider updated: ${labelFor(updated)}`, {
        providerId: updated.id,
        changed: Object.keys(patch),
      });
      return updated;
    },
    async remove(id) {
      const current = await requireProvider(id);
      if (current.managedByEnv) {
        throw new ApiHttpError(
          "forbidden",
          "this provider is set by the deployment; remove SFTPGO_URL to manage it here",
        );
      }
      try {
        await repo.delete(id);
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new ApiHttpError("conflict", "logins still use this provider");
        }
        throw error;
      }
      eventLog.record("general", "info", `Storage provider removed: ${labelFor(current)}`, {
        providerId: current.id,
      });
    },
    async probe(target) {
      if (typeof target === "string") {
        const found = await get(target);
        if (found === null) {
          throw new ApiHttpError("not_found", "storage provider not found");
        }
        return probeInstance(found.module, found.instance);
      }
      const module = requireModule(target.type);
      const config = assertValidConfig(module, target.config);
      return probeInstance(module, { id: "", baseUrl: target.baseUrl, config });
    },
    capabilitiesFor,
    labelFor,
    publicView(provider) {
      const module = moduleForType(provider.type);
      if (module === null) {
        return null;
      }
      return {
        id: provider.id,
        type: module.type as PublicProvider["type"],
        label: labelFor(provider),
        credentialFields: [...module.credentialFields],
      };
    },
    async adminView(provider) {
      const module = moduleForType(provider.type);
      if (module === null) {
        return null;
      }
      const config: Record<string, string> = {};
      for (const [key, value] of Object.entries(provider.config)) {
        if (typeof value === "string") {
          config[key] = value;
        }
      }
      const probe = await probeInstance(module, instanceOf(provider));
      return {
        id: provider.id,
        type: module.type as AdminProvider["type"],
        label: labelFor(provider),
        baseUrl: provider.baseUrl,
        config,
        enabled: provider.enabled,
        managedByEnv: provider.managedByEnv,
        identityCount: await deps.repos.identities.countByProvider(provider.id),
        reachable: probe.ok,
        checkedAt: deps.clock().toISOString(),
        createdAt: provider.createdAt.toISOString(),
      };
    },
    types() {
      return Object.values(modules).map((module) => ({
        type: module.type as AdminProviderType["type"],
        label: module.label,
        configFields: [...module.configFields],
        credentialFields: [...module.credentialFields],
        capabilities: module.capabilities,
      }));
    },
    async seedFromEnvironment() {
      const stored = await deps.repos.settings.get<StoredConnection>(
        LEGACY_CONNECTION_SETTINGS_KEY,
      );
      const envUrl = deps.environment.sftpgoUrl;
      const rows = await repo.list();
      for (const row of rows) {
        if (row.managedByEnv && (envUrl === undefined || row.baseUrl !== envUrl)) {
          await repo.update(row.id, { managedByEnv: false });
        }
      }
      const homeTemplateFor = (row: Provider): string | undefined =>
        typeof row.config.homeTemplate === "string"
          ? undefined
          : (stored?.homeTemplate ?? deps.environment.homeTemplate);
      if (envUrl !== undefined && envUrl.length > 0) {
        const row = await repo.ensure({ type: "sftpgo", baseUrl: envUrl });
        const homeTemplate = homeTemplateFor(row);
        await repo.update(row.id, {
          managedByEnv: true,
          enabled: true,
          ...(homeTemplate === undefined ? {} : { config: { ...row.config, homeTemplate } }),
        });
      } else if (stored?.baseUrl !== undefined) {
        const row = await repo.ensure({ type: "sftpgo", baseUrl: stored.baseUrl });
        const homeTemplate = homeTemplateFor(row);
        if (homeTemplate !== undefined) {
          await repo.update(row.id, { config: { ...row.config, homeTemplate } });
        }
      }
      if (stored !== null) {
        await deps.repos.settings.delete(LEGACY_CONNECTION_SETTINGS_KEY);
      }
    },
  };
}
