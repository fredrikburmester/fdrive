import type { ProviderModule } from "@fdrive/core";
import type { Provider, Repos } from "@fdrive/db";
import { vi } from "vitest";
import type { SystemEventLog } from "../../system/event-log.js";
import { createProviderService, type ProviderService } from "../service.js";

export interface MemoryProviderServiceOptions {
  readonly eventLog?: SystemEventLog;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  readonly sftpgoUrl?: string | undefined;
  readonly homeTemplate?: string;
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
    environment: {
      sftpgoUrl: options.sftpgoUrl,
      homeTemplate: options.homeTemplate ?? "sftpgo:/{username}",
      indexRootNames: options.indexRootNames ?? [],
    },
    ...(options.trashEnabled === undefined ? {} : { trashEnabled: options.trashEnabled }),
    ...(options.eventLog === undefined ? {} : { eventLog: options.eventLog }),
    ...(options.modules === undefined ? {} : { modules: options.modules }),
  });
}

/** Ensures an enabled SFTPGo provider row at `baseUrl`, with an optional home template. */
export async function seedSftpgoProvider(
  repos: Pick<Repos, "providers">,
  baseUrl: string,
  options: { homeTemplate?: string; enabled?: boolean; managedByEnv?: boolean } = {},
): Promise<Provider> {
  const row = await repos.providers.ensure({ type: "sftpgo", baseUrl });
  const updated = await repos.providers.update(row.id, {
    enabled: options.enabled ?? true,
    managedByEnv: options.managedByEnv ?? false,
    config: { ...row.config, homeTemplate: options.homeTemplate ?? "sftpgo:/{username}" },
  });
  if (updated === null) throw new Error("provider vanished");
  return updated;
}

/** Ensures an enabled WebDAV provider row at `baseUrl`; the type has no configuration. */
export async function seedWebdavProvider(
  repos: Pick<Repos, "providers">,
  baseUrl: string,
  options: { label?: string; enabled?: boolean } = {},
): Promise<Provider> {
  const row = await repos.providers.ensure({ type: "webdav", baseUrl });
  const updated = await repos.providers.update(row.id, {
    enabled: options.enabled ?? true,
    managedByEnv: false,
    ...(options.label === undefined ? {} : { label: options.label }),
  });
  if (updated === null) throw new Error("provider vanished");
  return updated;
}

/** A fetch double that answers SFTPGo's health and token probes. */
export function probeFetch(reachable = true): typeof globalThis.fetch {
  return vi.fn(async (url: unknown) => {
    if (!reachable) return new Response("boom", { status: 500 });
    return String(url).endsWith("/healthz")
      ? new Response("ok", { status: 200 })
      : new Response("unauthorized", { status: 401 });
  }) as unknown as typeof globalThis.fetch;
}
