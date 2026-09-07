import { WopiError } from "./errors.ts";
import { buildActionUrl, requireHttpUrl } from "./protocol/discovery.ts";
import type { OfficeConfig } from "./types.ts";
export function officeActionUrl(
  template: string,
  config: OfficeConfig,
  fileId: string,
  ui?: string,
): string {
  const server = requireHttpUrl(config.serverUrl);
  const target = requireHttpUrl(config.publicUrl);
  const raw = requireHttpUrl(template.replace(/<[^<>]*>/g, ""));
  let mapped = template;
  if (raw.origin === server.origin) {
    const prefix = server.pathname.replace(/\/$/, "");
    if (prefix && raw.pathname !== prefix && !raw.pathname.startsWith(`${prefix}/`))
      throw new WopiError(502);
    const queryAt = template.indexOf("?");
    const suffix = `${raw.pathname.slice(prefix.length)}${queryAt < 0 ? "" : template.slice(queryAt)}`;
    mapped = `${config.publicUrl.replace(/\/$/, "")}${suffix.startsWith("/") ? "" : "/"}${suffix}`;
  } else if (raw.origin !== target.origin) throw new WopiError(502);
  const result = buildActionUrl(mapped, `${config.wopiUrl}/files/${fileId}`, {
    ui: ui ?? "en-us",
    rs: ui ?? "en-us",
    thm: "1",
    dchat: "1",
  });
  if (new URL(result).origin !== target.origin) throw new WopiError(502);
  return result;
}
export function callbackProofUrl(requestUrl: string, config: OfficeConfig): string {
  const url = new URL(requestUrl);
  if (!/^\/wopi\/files\/[^/]+(?:\/contents)?$/.test(url.pathname)) throw new WopiError(400);
  return `${config.wopiUrl}${url.pathname.slice(5)}${url.search}`;
}
export function editorHostUrl(
  config: OfficeConfig,
  identityId: string,
  path: string,
  mode: "view" | "edit",
): string {
  return `${config.appUrl.replace(/\/$/, "")}/office/${encodeURIComponent(identityId)}${path.split("/").map(encodeURIComponent).join("/")}?mode=${mode}`;
}
