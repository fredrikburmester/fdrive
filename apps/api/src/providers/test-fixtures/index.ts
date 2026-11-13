import { type ProviderModule, StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { Provider, Repos } from "@fdrive/db";
import { vi } from "vitest";
import type { SystemEventLog } from "../../system/event-log.js";
import { createProviderService, type ProviderService } from "../service.js";

export interface MemoryProviderServiceOptions {
  readonly eventLog?: SystemEventLog;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  readonly indexRootNames?: readonly string[];
  readonly trashEnabled?: (providerId: string) => Promise<boolean>;
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
    ...(options.modules === undefined ? {} : { modules: options.modules }),
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

/** Ensures an enabled WebDAV provider row at `baseUrl`; the type has no configuration. */
export async function seedWebdavProvider(
  repos: Pick<Repos, "providers">,
  baseUrl: string,
  options: { label?: string; enabled?: boolean; managedByEnv?: boolean } = {},
): Promise<Provider> {
  const row = await repos.providers.ensure({ type: "webdav", baseUrl });
  const updated = await repos.providers.update(row.id, {
    enabled: options.enabled ?? true,
    managedByEnv: options.managedByEnv ?? false,
    ...(options.label === undefined ? {} : { label: options.label }),
  });
  if (updated === null) throw new Error("provider vanished");
  return updated;
}

/** A fetch double that answers WebDAV's unauthenticated `OPTIONS` probe. */
export function probeFetch(reachable = true): typeof globalThis.fetch {
  return vi.fn(async () =>
    reachable
      ? new Response(null, { status: 200, headers: { dav: "1, 2" } })
      : new Response("boom", { status: 500 }),
  ) as unknown as typeof globalThis.fetch;
}

/** Ensures an enabled S3 provider row at `baseUrl` (bucket in the path), with an optional region. */
export async function seedS3Provider(
  repos: Pick<Repos, "providers">,
  baseUrl: string,
  options: { label?: string; region?: string; enabled?: boolean } = {},
): Promise<Provider> {
  const row = await repos.providers.ensure({ type: "s3", baseUrl });
  const updated = await repos.providers.update(row.id, {
    enabled: options.enabled ?? true,
    managedByEnv: false,
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.region === undefined ? {} : { config: { ...row.config, region: options.region } }),
  });
  if (updated === null) throw new Error("provider vanished");
  return updated;
}

/**
 * A provider module for tests of generic behaviour, registered under a real
 * type (`webdav` unless overridden) so the registry accepts its rows. Its
 * users sign in with `<username>-pass`, its storage is in memory, and every
 * part can be overridden.
 */
export function fakeProviderModule(overrides: Partial<ProviderModule> = {}): ProviderModule {
  return {
    type: "webdav",
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
