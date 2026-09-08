import type { AppConfig } from "../config.js";
import { requireHttpUrl } from "./protocol/discovery.ts";
import type { OfficeConfig } from "./types.ts";

export function configuredOfficeProduct(config: AppConfig): "onlyoffice" | "collabora" {
  return config.fdriveOfficeProduct ?? "onlyoffice";
}

/** Validates immutable endpoint overrides without activating Office. */
export function validateOfficeInfrastructure(config: AppConfig): void {
  for (const value of [
    config.fdriveOfficeUrl,
    config.fdriveOfficePublicUrl,
    config.fdriveWopiUrl,
  ]) {
    if (value === undefined) continue;
    const url = requireHttpUrl(value);
    if (url.search) throw new Error("Office URLs cannot contain queries");
  }
  if (
    config.fdriveWopiUrl !== undefined &&
    !new URL(config.fdriveWopiUrl).pathname.endsWith("/wopi")
  )
    throw new Error("FDRIVE_WOPI_URL must end in /wopi");
  if (
    config.fdriveOfficeProduct === "collabora" &&
    (config.fdriveOfficeUrl === undefined || config.fdriveOfficePublicUrl === undefined)
  )
    throw new Error(
      "Collabora requires FDRIVE_OFFICE_URL and FDRIVE_OFFICE_PUBLIC_URL endpoint overrides",
    );
}

/** Resolves one runtime snapshot from persisted activation and immutable endpoint overrides. */
export function officeConfig(config: AppConfig, appUrl: string): OfficeConfig {
  const origin = new URL(requireHttpUrl(appUrl)).origin;
  const resolved: OfficeConfig = {
    product: configuredOfficeProduct(config),
    serverUrl: config.fdriveOfficeUrl ?? "http://onlyoffice",
    publicUrl: config.fdriveOfficePublicUrl ?? `${origin}/onlyoffice`,
    wopiUrl: config.fdriveWopiUrl ?? "http://api:3001/wopi",
    appUrl: origin,
    maxBytes: config.fdriveOfficeMaxBytes ?? 104857600,
  };
  validateOfficeConfig(resolved);
  return resolved;
}

function validateOfficeConfig(config: OfficeConfig): void {
  for (const value of [config.serverUrl, config.publicUrl, config.wopiUrl, config.appUrl]) {
    const url = requireHttpUrl(value);
    if (url.search) throw new Error("Office URLs cannot contain queries");
  }
  if (!new URL(config.wopiUrl).pathname.endsWith("/wopi"))
    throw new Error("FDRIVE_WOPI_URL must end in /wopi");
}
