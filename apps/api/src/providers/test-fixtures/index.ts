import { type ProviderModule, StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { Provider, Repos } from "@fdrive/db";
import type { SystemEventLog } from "../../system/event-log.js";
import { createProviderService, type ProviderService } from "../service.js";

export interface MemoryProviderServiceOptions {
  readonly eventLog?: SystemEventLog;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  readonly indexRootNames?: readonly string[];
  readonly trashEnabled?: (providerId: string) => Promise<boolean>;
  /** The deployment's modules by type; none unless given. */
  readonly modules?: Readonly<Record<string, ProviderModule>>;
}

/** Test double only: a `ProviderService` over in-memory repos with optional event recording. */
export function memoryProviderService(
  repos: Pick<Repos, "providers" | "identities">,
  options: MemoryProviderServiceOptions = {},
): ProviderService {
  return createProviderService({
    repos,
    fetch: options.fetch ?? globalThis.fetch,
    clock: options.clock ?? (() => new Date()),
    environment: { indexRootNames: options.indexRootNames ?? [] },
    ...(options.trashEnabled === undefined ? {} : { trashEnabled: options.trashEnabled }),
    ...(options.eventLog === undefined ? {} : { eventLog: options.eventLog }),
    modules: options.modules ?? {},
  });
}

/**
 * Ensures the local folder's row as `seedFromEnvironment` leaves it: type
 * `local`, stored under the address `local`, pinned and enabled unless told
 * otherwise.
 */
export async function seedLocalProvider(
  repos: Pick<Repos, "providers">,
  options: { label?: string; enabled?: boolean; managedByEnv?: boolean } = {},
): Promise<Provider> {
  const row = await repos.providers.ensure({ type: "local", baseUrl: "local" });
  const updated = await repos.providers.update(row.id, {
    enabled: options.enabled ?? true,
    managedByEnv: options.managedByEnv ?? true,
    ...(options.label === undefined ? {} : { label: options.label }),
  });
  if (updated === null) throw new Error("provider vanished");
  return updated;
}

/**
 * Ensures another enabled, unpinned row of the files folder's type at
 * `baseUrl`, for tests of behaviour across rows: logins, tokens and storage
 * stay bound to the row they were verified against. The registry resolves
 * it through whatever module the test registers under `local`.
 */
export async function seedProviderRow(
  repos: Pick<Repos, "providers">,
  baseUrl: string,
  options: { label?: string; enabled?: boolean; managedByEnv?: boolean } = {},
): Promise<Provider> {
  const row = await repos.providers.ensure({ type: "local", baseUrl });
  const updated = await repos.providers.update(row.id, {
    enabled: options.enabled ?? true,
    managedByEnv: options.managedByEnv ?? false,
    ...(options.label === undefined ? {} : { label: options.label }),
  });
  if (updated === null) throw new Error("provider vanished");
  return updated;
}

/**
 * A provider module for tests of generic behaviour, registered under the
 * only type there is (`local`) so the registry accepts its rows. Its users
 * sign in with `<username>-pass`, its storage is in memory, and every part
 * can be overridden.
 */
export function fakeProviderModule(overrides: Partial<ProviderModule> = {}): ProviderModule {
  return {
    type: "local",
    label: "Fake storage",
    configFields: [],
    credentialFields: [
      { name: "username", label: "Username", kind: "text", required: true, maxLength: 255 },
      { name: "password", label: "Password", kind: "password", required: true },
    ],
    capabilities: {
      zip: false,
      setModifiedAt: false,
      atomicMove: true,
      trash: false,
      shares: false,
      office: false,
      index: false,
      shareWithPeople: false,
    },
    trash: "none",
    shares: "none",
    probe: async () => ({ ok: true, detail: "reachable" }),
    async authenticate(_instance, credential, ctx) {
      const username = credential.username ?? ctx.expectedUsername ?? "";
      if (username.length === 0 || credential.password !== `${username}-pass`) {
        throw new StorageError("unauthorized", "invalid username or password");
      }
      return { externalUsername: username };
    },
    createStorage: () => createMemoryStorage(),
    ...overrides,
  };
}
