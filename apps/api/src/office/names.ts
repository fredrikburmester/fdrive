import { isOfficeFilename } from "@fdrive/contracts";
import { extensionOf } from "@fdrive/core";
import { WopiError } from "./errors.ts";

/** RFC 2152 UTF-7 used by WOPI filename headers. */
export function decodeUtf7(input: string): string {
  if (input.length > 2048 || !/^[\x20-\x7e]*$/.test(input)) throw new WopiError(400);
  let result = "";
  for (let offset = 0; offset < input.length; ) {
    const char = input.charAt(offset++);
    if (char !== "+") {
      result += char;
      continue;
    }
    const end = input.indexOf("-", offset);
    if (end < 0) throw new WopiError(400);
    const encoded = input.slice(offset, end);
    offset = end + 1;
    if (encoded === "") {
      result += "+";
      continue;
    }
    if (!/^[A-Za-z0-9+/]+$/.test(encoded)) throw new WopiError(400);
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.length === 0 ||
      bytes.length % 2 !== 0 ||
      bytes.toString("base64").replace(/=+$/, "") !== encoded
    )
      throw new WopiError(400);
    for (let i = 0; i < bytes.length; i += 2) result += String.fromCharCode(bytes.readUInt16BE(i));
  }
  if (/[\uD800-\uDFFF]/u.test(result)) throw new WopiError(400);
  return result;
}
export function requireFilename(name: string): string {
  if (!isOfficeFilename(name))
    throw new WopiError(400, { "X-WOPI-InvalidFileNameError": "Invalid filename" });
  return name;
}
export function stemOf(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  const ext = extensionOf(name);
  return ext ? name.slice(0, -ext.length) : name;
}
export function suggestedFilename(source: string, suggestion: string, attempt: number): string {
  let candidate = suggestion.startsWith(".") ? `${stemOf(source)}${suggestion}` : suggestion;
  candidate = candidate.replace(/[\\/\p{Cc}]/gu, "_");
  if (candidate === "" || candidate === "." || candidate === "..") candidate = "Untitled";
  const lowerSuffix = extensionOf(candidate);
  const suffix = lowerSuffix ? candidate.slice(-lowerSuffix.length) : "";
  let stem = stemOf(candidate);
  while (Buffer.byteLength(`${stem}${suffix}`, "utf8") > 235 && stem.length > 0)
    stem = Array.from(stem).slice(0, -1).join("");
  candidate = requireFilename(`${stem || "Untitled"}${suffix}`);
  if (attempt === 0) return candidate;
  const ext = suffix;
  return requireFilename(`${stemOf(candidate)} (${attempt})${ext}`);
}
export function lockHeader(value: string | null, required = false): string | undefined {
  if (value === null && !required) return undefined;
  if (value === null || !/^[\x20-\x7e]{1,1024}$/.test(value)) throw new WopiError(400);
  return value;
}
