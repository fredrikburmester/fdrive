import { ProviderType } from "@fdrive/contracts";
import type { ProviderModule } from "@fdrive/core";
import { type CreateLocalModuleOptions, createLocalModule } from "@fdrive/local";

/** The provider modules one deployment has, by type. */
export type ProviderModules = Readonly<Record<string, ProviderModule>>;

/**
 * The storage this deployment serves, by type: the files folder, when the
 * deployment configures one (`FDRIVE_STORAGE_ROOT`), since it needs the
 * folder and fdrive's own users. Without it there is no storage. Routes, the
 * web app, the database schema and the indexer reach storage only through
 * the `ProviderModule` port, never the module itself.
 */
export function createProviderModules(
  options: { readonly local?: CreateLocalModuleOptions } = {},
): ProviderModules {
  return options.local === undefined ? {} : { local: createLocalModule(options.local) };
}

/** True when `type` names a provider type this build knows. */
export function isProviderType(type: string): type is ProviderType {
  return ProviderType.safeParse(type).success;
}

/** The module for `type` in `modules`, or `null` for a type the deployment does not have. */
export function moduleFor(type: string, modules: ProviderModules): ProviderModule | null {
  return isProviderType(type) ? (modules[type] ?? null) : null;
}
