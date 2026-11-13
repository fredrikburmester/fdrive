import { ProviderType } from "@fdrive/contracts";
import type { ProviderModule } from "@fdrive/core";
import { type CreateLocalModuleOptions, createLocalModule } from "@fdrive/local";
import { s3Module } from "@fdrive/s3";
import { webdavModule } from "@fdrive/webdav";

/** The provider modules one deployment has, by type. */
export type ProviderModules = Readonly<Record<string, ProviderModule>>;

/**
 * Every storage backend this deployment can talk to, by type. WebDAV and S3
 * are always there; the local folder joins when the deployment configures
 * one (`FDRIVE_STORAGE_ROOT`), since it needs the folder and fdrive's own
 * users. Adding a provider is one package exporting a `ProviderModule`, one
 * value in the contracts' `ProviderType` enum, and one line here; routes,
 * the web app, the database schema and the indexer never know which module
 * backs an identity.
 */
export function createProviderModules(
  options: { readonly local?: CreateLocalModuleOptions } = {},
): ProviderModules {
  return {
    ...(options.local === undefined ? {} : { local: createLocalModule(options.local) }),
    webdav: webdavModule,
    s3: s3Module,
  };
}

/** The modules every deployment has: no local folder. */
export const PROVIDER_MODULES: ProviderModules = createProviderModules();

/** True when `type` names a provider type this build knows. */
export function isProviderType(type: string): type is ProviderType {
  return ProviderType.safeParse(type).success;
}

/** The module for `type` in `modules`, or `null` for a type the deployment does not have. */
export function moduleFor(type: string, modules: ProviderModules = PROVIDER_MODULES) {
  return isProviderType(type) ? (modules[type] ?? null) : null;
}
