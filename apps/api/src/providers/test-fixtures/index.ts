import type { ProviderModule } from "@fdrive/core";
import type { Provider, Repos } from "@fdrive/db";
import { createProviderService, type ProviderService } from "../service.js";

export interface MemoryProviderServiceOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  readonly sftpgoUrl?: string | undefined;
  readonly homeTemplate?: string;
  readonly indexRootNames?: readonly string[];
  readonly trashEnabled?: (providerId: string) => Promise<boolean>;
  readonly modules?: Readonly<Record<string, ProviderModule>>;
}

/** Test double only: a `ProviderService` over in-memory repos with no event log. */
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
