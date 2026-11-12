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
  readonly repos: Pick<Repos, "providers" | "identities">;
  readonly fetch: typeof globalThis.fetch;
  readonly clock: () => Date;
  readonly eventLog?: SystemEventLog;
  /** Which index roots (`FDRIVE_INDEX_ROOTS`) exist for a provider's files to be indexed under. */
  readonly environment: {
    readonly indexRootNames: readonly string[];
  };
  /** Whether the recycle folder is switched on for a provider (Trash settings). */
  readonly trashEnabled?: (providerId: string) => Promise<boolean>;
  /**
   * The modules this deployment has, by type (`createProviderModules`): the
   * local folder joins them when `FDRIVE_STORAGE_ROOT` is set. Defaults to
   * the modules every deployment has.
   */
  readonly modules?: Readonly<Record<string, ProviderModule>>;
}

export interface ProviderService {
  /** Every provider row, oldest first. */
  list(): Promise<Provider[]>;
  /** Enabled providers only, oldest first: what users may log in to. */
  enabled(): Promise<Provider[]>;
  /** The enabled provider the deployment pins, else the oldest enabled one; `null` before setup. */
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
  /**
   * The admin-set label, else the endpoint host, or the module's own name for
   * a row with no endpoint: for callers that already know the row.
   */
  labelFor(provider: Provider): string;
  /**
   * The login page's view of a row. Its `label` is the admin-set one or
   * empty, never the host: this is served to anonymous callers.
   */
  publicView(provider: Provider): PublicProvider | null;
  /** The admin view of a row, including a fresh reachability probe unless provided. */
  adminView(provider: Provider, probeResult?: { ok: boolean }): Promise<AdminProvider | null>;
  types(): AdminProviderType[];
  /**
   * Runs once at startup: creates and pins the row of every module the
   * deployment manages (the local folder, when `FDRIVE_STORAGE_ROOT` is
   * set), and unpins and disables any other pinned row, such as an SFTPGo
   * row from before the local folder replaced it or a local row whose folder
   * is no longer configured. A row that already exists keeps whatever
   * enabled state an admin gave it. Idempotent.
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

/**
 * The endpoint a deployment-managed row is stored under. It has none, and
 * one fixed value keeps its row unique per type, wherever the folder is
 * mounted.
 */
function managedBaseUrl(module: ProviderModule): string {
  return module.type;
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

  const labelFor = (provider: Provider): string => {
    if (provider.label.length > 0) return provider.label;
    const module = moduleForType(provider.type);
    return module?.deploymentManaged === true ? module.label : hostLabel(provider.baseUrl);
  };

  async function capabilitiesFor(target: ResolvedProvider): Promise<ProviderCapabilities> {
    const flags = target.module.capabilities;
    // Indexing is per row: only a provider whose files live under one of the
    // configured index roots has search, thumbnails and folder sizes.
    const root = target.module.indexRootName?.(target.instance) ?? null;
    const hasRoots = root !== null && deps.environment.indexRootNames.includes(root);
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
      shareWithPeople: flags.shareWithPeople,
      index: flags.index && hasRoots,
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
      const usable = (await repo.list()).filter(
        (provider) => provider.enabled && moduleForType(provider.type) !== null,
      );
      return usable.find((provider) => provider.managedByEnv) ?? usable[0] ?? null;
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
      if (module.deploymentManaged === true) {
        throw new ApiHttpError("bad_request", `${module.label} is set up by the deployment`);
      }
      const config = assertValidConfig(module, input.config);
      const provider = await repo
        .create({
          type: input.type,
          baseUrl: input.baseUrl,
          label: input.label,
          config,
          enabled: opts?.enabled ?? true,
          managedByEnv: opts?.managedByEnv ?? false,
        })
        .catch((error: unknown) => {
          if (error instanceof ConflictError)
            throw new ApiHttpError("conflict", "a provider with this endpoint already exists");
          throw error;
        });
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
        const taken = (await repo.list()).some(
          (provider) =>
            provider.id !== id &&
            provider.type === current.type &&
            provider.baseUrl === patch.baseUrl,
        );
        if (taken) {
          throw new ApiHttpError("conflict", "a provider with this endpoint already exists");
        }
      }
      const config =
        patch.config === undefined ? undefined : assertValidConfig(module, patch.config);
      const updated = await repo
        .update(id, {
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
          ...(config !== undefined ? { config } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        })
        .catch((error: unknown) => {
          if (error instanceof ConflictError)
            throw new ApiHttpError(
              "conflict",
              "provider update conflicts with an existing endpoint or login",
            );
          throw error;
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
          "this provider is set by the deployment; remove FDRIVE_STORAGE_ROOT to manage it here",
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
        label: provider.label,
        credentialFields: [...module.credentialFields],
        capabilities: module.capabilities,
      };
    },
    async adminView(provider, probeResult) {
      const module = moduleForType(provider.type);
      if (module === null) {
        return null;
      }
      const config = Object.fromEntries(
        Object.entries(provider.config).filter(([_, v]) => typeof v === "string"),
      ) as Record<string, string>;
      const probe = probeResult ?? (await probeInstance(module, instanceOf(provider)));
      return {
        id: provider.id,
        type: module.type as AdminProvider["type"],
        label: labelFor(provider),
        baseUrl: module.deploymentManaged === true ? "" : provider.baseUrl,
        config,
        enabled: provider.enabled,
        managedByEnv: provider.managedByEnv,
        capabilities: module.capabilities,
        identityCount: await deps.repos.identities.countByProvider(provider.id),
        reachable: probe.ok,
        checkedAt: deps.clock().toISOString(),
        createdAt: provider.createdAt.toISOString(),
      };
    },
    types() {
      return Object.values(modules)
        .filter((module) => module.deploymentManaged !== true)
        .map((module) => ({
          type: module.type as AdminProviderType["type"],
          label: module.label,
          configFields: [...module.configFields],
          credentialFields: [...module.credentialFields],
          capabilities: module.capabilities,
        }));
    },
    async seedFromEnvironment() {
      const managed = Object.values(modules).filter((module) => module.deploymentManaged === true);
      const rows = await repo.list();
      for (const row of rows) {
        if (!row.managedByEnv || managed.some((module) => module.type === row.type)) continue;
        // The deployment no longer configures this row (an SFTPGo row from
        // before the local folder, or a local row whose folder was removed):
        // its logins stop, and an administrator decides what happens next.
        await repo.update(row.id, { managedByEnv: false, enabled: false });
        eventLog.record(
          "general",
          "info",
          `Storage provider disabled: ${labelFor(row)} (the deployment no longer configures it)`,
          { providerId: row.id },
        );
      }
      for (const module of managed) {
        const existing = rows.find((row) => row.type === module.type);
        const row =
          existing ?? (await repo.ensure({ type: module.type, baseUrl: managedBaseUrl(module) }));
        // Only a row this seed creates starts enabled; one an admin disabled
        // stays that way across restarts.
        await repo.update(row.id, {
          managedByEnv: true,
          ...(existing === undefined ? { enabled: true } : {}),
        });
      }
    },
  };
}
