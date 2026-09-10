import { ProviderType } from "@fdrive/contracts";
import type { ProviderModule } from "@fdrive/core";
import { sftpgoModule } from "@fdrive/sftpgo";

/**
 * Every storage backend this API can talk to, by type. Adding a provider is
 * one package exporting a `ProviderModule`, one value in the contracts'
 * `ProviderType` enum, and one line here; routes, the web app, the database
 * schema and the indexer never know which module backs an identity.
 */
export const PROVIDER_MODULES: Readonly<Record<ProviderType, ProviderModule>> = {
  sftpgo: sftpgoModule,
};

/** True when `type` names a registered provider module. */
export function isProviderType(type: string): type is ProviderType {
  return ProviderType.safeParse(type).success;
}

/** The module for `type`, or `null` for a type this build does not know. */
export function moduleFor(type: string): ProviderModule | null {
  return isProviderType(type) ? PROVIDER_MODULES[type] : null;
}
