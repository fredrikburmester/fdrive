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
import { CoreError, parseHomeTemplate, validateFields } from "@fdrive/core";
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
  /**
   * How `SFTPGO_URL` and `FDRIVE_HOME_TEMPLATE` seed and pin the first
   * SFTPGo provider, and which index roots (`FDRIVE_INDEX_ROOTS`) exist for
   * a provider's files to be indexed under.
   */
  readonly environment: {
    readonly sftpgoUrl: string | undefined;
    readonly homeTemplate: string;
    readonly indexRootNames: readonly string[];
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
  /** The enabled provider pinned by `SFTPGO_URL`, else the oldest enabled one; `null` before setup. */
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
  /** The admin-set label, else the endpoint host: for callers that already know the row. */
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
   * Runs once at startup: creates or pins the SFTPGo provider named by
   * `SFTPGO_URL` and unpins any row the variable no longer names. A row
   * that already exists keeps whatever enabled state an admin gave it;
   * a row the variable moved away from is also disabled, so the deployment
   * has one default again. Idempotent.
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
  const homeTemplate = result.value.homeTemplate;
  if (module.type === "sftpgo" && homeTemplate) {
    try {
      parseHomeTemplate(homeTemplate);
    } catch (error) {
      throw new ApiHttpError(
        "bad_request",
        error instanceof CoreError ? error.message : "invalid home template",
        error instanceof CoreError ? error.details : undefined,
      );
    }
  }
  return result.value;
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
    // Indexing is per row: only a provider whose files live under one of the
    // configured index roots has thumbnails, folder sizes and scope mapping.
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
              "logins already use this provider; add a new provider for another address",
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
        label: provider.label,
        credentialFields: [...module.credentialFields],
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
      const envUrl =
        deps.environment.sftpgoUrl === undefined || deps.environment.sftpgoUrl.length === 0
          ? undefined
          : deps.environment.sftpgoUrl;
      const rows = await repo.list();
      for (const row of rows) {
        if (
          !row.managedByEnv ||
          (envUrl !== undefined && row.baseUrl.replace(/\/+$/, "") === envUrl.replace(/\/+$/, ""))
        ) {
          continue;
        }
        // Without the variable the row is simply handed to the admin. With
        // it pointing elsewhere the deployment has moved: retire this row
        // so its logins stop and the new address is the only default.
        const moved = envUrl !== undefined;
        await repo.update(row.id, { managedByEnv: false, ...(moved ? { enabled: false } : {}) });
        eventLog.record(
          "general",
          "info",
          moved
            ? `Storage provider disabled: ${labelFor(row)} (SFTPGO_URL now names another server)`
            : `Storage provider unpinned: ${labelFor(row)} (SFTPGO_URL is no longer set)`,
          { providerId: row.id },
        );
      }
      if (envUrl === undefined) {
        return;
      }
      const matching = rows.filter(
        (row) =>
          row.type === "sftpgo" && row.baseUrl.replace(/\/+$/, "") === envUrl.replace(/\/+$/, ""),
      );
      // Existing installations can contain both spellings. Keep the pinned
      // identity binding rather than adopting an older, unpinned duplicate.
      const existing = matching.find((row) => row.managedByEnv) ?? matching[0];
      const row = existing ?? (await repo.ensure({ type: "sftpgo", baseUrl: envUrl }));
      // Only a row this seed creates starts enabled; one an admin disabled
      // stays that way across restarts.
      await repo.update(row.id, {
        managedByEnv: true,
        ...(existing === undefined ? { enabled: true } : {}),
        ...(typeof row.config.homeTemplate === "string"
          ? {}
          : { config: { ...row.config, homeTemplate: deps.environment.homeTemplate } }),
      });
    },
  };
}
