import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { importProofKey, type ProofKeys } from "./proof.ts";

const actionSchema = z.object({
  "@_ext": z.string(),
  "@_name": z.string().min(1),
  "@_urlsrc": z.string().min(1),
});
const appSchema = z.object({ "@_name": z.string(), action: z.array(actionSchema) });
const zoneSchema = z.object({ "@_name": z.string(), app: z.array(appSchema) });
const keySchema = z.object({
  "@_modulus": z.string(),
  "@_exponent": z.string(),
  "@_oldmodulus": z.string().optional(),
  "@_oldexponent": z.string().optional(),
});
const discoverySchema = z.object({
  "wopi-discovery": z.object({ "net-zone": z.array(zoneSchema).min(1), "proof-key": keySchema }),
});

export interface DiscoveryAction {
  readonly extension: string;
  readonly name: string;
  readonly url: string;
  readonly app: string;
  readonly zone: string;
}
export interface WopiDiscovery {
  readonly actions: readonly DiscoveryAction[];
  readonly proofKeys: ProofKeys;
}
export interface ActionParameters {
  readonly ui?: string;
  readonly rs?: string;
  readonly thm?: "1" | "2";
  readonly dchat?: "1";
}

export function requireHttpUrl(value: string): URL {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject URL parser normalization of controls.
  if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error("URL contains whitespace or controls");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("Expected an absolute HTTP(S) URL without credentials or fragment");
  }
  return url;
}

export function parseDiscovery(xml: string): WopiDiscovery {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error("Invalid discovery XML");
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    isArray: (name: string) => ["net-zone", "app", "action"].includes(name),
  });
  const parsed: unknown = parser.parse(xml);
  const root = discoverySchema.parse(parsed)["wopi-discovery"];
  const key = root["proof-key"];
  const current = { modulus: key["@_modulus"], exponent: key["@_exponent"] };
  importProofKey(current);
  let proofKeys: ProofKeys = { current };
  if (key["@_oldmodulus"] !== undefined || key["@_oldexponent"] !== undefined) {
    if (key["@_oldmodulus"] === undefined || key["@_oldexponent"] === undefined)
      throw new Error("Incomplete old proof key");
    const old = { modulus: key["@_oldmodulus"], exponent: key["@_oldexponent"] };
    importProofKey(old);
    proofKeys = { current, old };
  }
  const actions = root["net-zone"].flatMap((zone) =>
    zone.app.flatMap((app) =>
      app.action.map((action) => {
        const url = action["@_urlsrc"];
        requireHttpUrl(url.replace(/<[^<>]*>/g, ""));
        return {
          extension: action["@_ext"].toLowerCase(),
          name: action["@_name"],
          url,
          app: app["@_name"],
          zone: zone["@_name"],
        };
      }),
    ),
  );
  return { actions, proofKeys };
}

export function selectDiscoveryAction(
  discovery: WopiDiscovery,
  extension: string,
  name: string,
  zone?: string,
): DiscoveryAction | undefined {
  const ext = extension.replace(/^\./, "").toLowerCase();
  return discovery.actions.find(
    (action) =>
      action.extension === ext &&
      action.name === name &&
      (zone === undefined || action.zone === zone),
  );
}

/** https://api.onlyoffice.com/docs/docs-api/using-wopi/wopi-discovery/ */
export function buildActionUrl(
  template: string,
  wopiSrc: string,
  parameters: ActionParameters = {},
): string {
  requireHttpUrl(wopiSrc);
  const expanded = template.replace(/<([^<>]*)>/g, (_match: string, placeholder: string) => {
    const name = placeholder.split("=", 1)[0];
    if (name !== "ui" && name !== "rs" && name !== "thm" && name !== "dchat") return "";
    const value = parameters[name];
    return value === undefined ? "" : `${name}=${encodeURIComponent(value)}&`;
  });
  const url = requireHttpUrl(expanded);
  // URLSearchParams would reserialize existing signed or product-specific query values.
  if ([...url.searchParams.keys()].some((key) => key.toLowerCase() === "wopisrc"))
    throw new Error("Action already contains WOPISrc");
  const separator = expanded.includes("?") ? (/[?&]$/.test(expanded) ? "" : "&") : "?";
  return `${expanded}${separator}WOPISrc=${encodeURIComponent(wopiSrc)}`;
}
