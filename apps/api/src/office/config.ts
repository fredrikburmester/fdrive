import type { AppConfig } from "../config.js";
import { requireHttpUrl } from "./protocol/discovery.ts";
import type { OfficeConfig } from "./types.ts";
export function officeConfig(config: AppConfig): OfficeConfig | null {
  const {
    fdriveOfficeProduct: product,
    fdriveOfficeUrl: serverUrl,
    fdriveOfficePublicUrl: publicUrl,
    fdriveWopiUrl: wopiUrl,
    fdrivePublicUrl: appUrl,
  } = config;
  if (
    product === undefined &&
    serverUrl === undefined &&
    publicUrl === undefined &&
    wopiUrl === undefined
  )
    return null;
  if (
    product === undefined ||
    serverUrl === undefined ||
    publicUrl === undefined ||
    wopiUrl === undefined ||
    appUrl === undefined
  )
    throw new Error(
      "Office requires FDRIVE_OFFICE_PRODUCT, FDRIVE_OFFICE_URL, FDRIVE_OFFICE_PUBLIC_URL, FDRIVE_WOPI_URL and FDRIVE_PUBLIC_URL",
    );
  for (const value of [serverUrl, publicUrl, wopiUrl, appUrl]) {
    const url = requireHttpUrl(value);
    if (url.search) throw new Error("Office URLs cannot contain queries");
  }
  if (!new URL(wopiUrl).pathname.endsWith("/wopi"))
    throw new Error("FDRIVE_WOPI_URL must end in /wopi");
  return {
    product,
    serverUrl,
    publicUrl,
    wopiUrl,
    appUrl,
    maxBytes: config.fdriveOfficeMaxBytes ?? 104857600,
  };
}
