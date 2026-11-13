import type {
  AdminProvider,
  AdminProviderUpdateRequest,
  ProviderCapabilities,
  PublicProvider,
} from "@fdrive/contracts";
import type { ProviderInstance, ProviderModule } from "@fdrive/core";
import type { Identity, Provider, ProviderRepo, Repos } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";
import { noopSystemEventLog, type SystemEventLog } from "../system/event-log.js";
import { moduleFor, type ProviderModules } from "./registry.js";

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
   * files folder when `FDRIVE_STORAGE_ROOT` is set, else none.
   */
  readonly modules: ProviderModules;
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
  /** Renames a provider: the label the login page and the admin view show. */
  update(id: string, patch: AdminProviderUpdateRequest): Promise<Provider>;
  capabilitiesFor(resolved: ResolvedProvider): Promise<ProviderCapabilities>;
  /**
   * The admin-set label, else the module's own name; a row whose module this
   * deployment no longer has falls back to its stored endpoint host.
   */
  labelFor(provider: Provider): string;
  /**
   * The login page's view of a row. Its `label` is the admin-set one or
   * empty, never the host: this is served to anonymous callers.
   */
  publicView(provider: Provider): PublicProvider | null;
  /** The admin view of a row, including a fresh reachability probe. */
  adminView(provider: Provider): Promise<AdminProvider | null>;
  /**
   * Runs once at startup: creates and pins the row of every module the
   * deployment manages (the local folder, when `FDRIVE_STORAGE_ROOT` is
   * set), and unpins and disables any other pinned row, such as a local row
   * whose folder is no longer configured. The pinned row is always enabled:
   * nothing but the deployment turns it on or off. Idempotent.
   */
  seedFromEnvironment(): Promise<void>;
}

/** The host of a stored endpoint; the label of a row whose module is gone. */
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
  const modules = deps.modules;
  const moduleForType = (type: string): ProviderModule | null => moduleFor(type, modules);

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

  const labelFor = (provider: Provider): string => {
    if (provider.label.length > 0) return provider.label;
    return moduleForType(provider.type)?.label ?? hostLabel(provider.baseUrl);
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
    async update(id, patch) {
      const updated = await repo.update(id, { label: patch.label });
      if (updated === null) {
        throw new ApiHttpError("not_found", "storage provider not found");
      }
      eventLog.record("general", "info", `Storage provider renamed: ${labelFor(updated)}`, {
        providerId: updated.id,
      });
      return updated;
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
    async adminView(provider) {
      const module = moduleForType(provider.type);
      if (module === null) {
        return null;
      }
      const config = Object.fromEntries(
        Object.entries(provider.config).filter(([_, v]) => typeof v === "string"),
      ) as Record<string, string>;
      const probe = await module.probe(instanceOf(provider), { fetch: deps.fetch });
      return {
        id: provider.id,
        type: module.type as AdminProvider["type"],
        label: labelFor(provider),
        // The files folder has no endpoint; its row's address is a fixed key.
        baseUrl: "",
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
    async seedFromEnvironment() {
      const managed = Object.values(modules).filter((module) => module.deploymentManaged === true);
      const rows = await repo.list();
      for (const row of rows) {
        if (!row.managedByEnv || managed.some((module) => module.type === row.type)) continue;
        // The deployment no longer configures this row (a local row whose
        // folder was removed): its logins stop until the deployment
        // configures it again.
        await repo.update(row.id, { managedByEnv: false, enabled: false });
        eventLog.record(
          "general",
          "info",
          `Storage provider disabled: ${labelFor(row)} (the deployment no longer configures it)`,
          { providerId: row.id },
        );
      }
      for (const module of managed) {
        const key = { type: module.type, baseUrl: managedBaseUrl(module) };
        const row =
          rows.find((row) => row.type === key.type && row.baseUrl === key.baseUrl) ??
          (await repo.ensure(key));
        // The deployment decides: a folder it configures again after a start
        // without one serves its logins again.
        await repo.update(row.id, { managedByEnv: true, enabled: true });
      }
    },
  };
}
