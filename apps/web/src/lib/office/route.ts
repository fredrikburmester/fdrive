import { isOfficeFilename, isOfficePath, type OfficeMode } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { pathToHref } from "@/lib/files/path-url";

export function officeMode(value: string | string[] | undefined): OfficeMode {
  return value === "edit" || value === "convert" ? value : "view";
}

export function officeHref(identityId: string, path: string, mode: OfficeMode = "view"): string {
  if (!isOfficePath(path) || path === "/") throw new Error("Invalid office file path");
  return `/office/${encodeURIComponent(identityId)}/${path.slice(1).split("/").map(encodeURIComponent).join("/")}?mode=${mode}`;
}

export function officePathFromSegments(segments: readonly string[]): string {
  // Decode app-route segments once, preserving literal percent sequences in filenames.
  const decoded = segments.map(decodeURIComponent);
  if (!decoded.every(isOfficeFilename)) throw new Error("Invalid office file path");
  const path = `/${decoded.join("/")}`;
  if (!isOfficePath(path) || path === "/") throw new Error("Invalid office file path");
  return path;
}

export function officeFolderHref(path: string): string {
  return pathToHref(parentPath(path));
}

/** Rename notifications are hints until the API confirms the same durable file ID. */
export function renamedOfficePath(path: string, name: string): string | null {
  if (!isOfficeFilename(name)) return null;
  const extension = path.slice(path.lastIndexOf("/") + 1).match(/\.[^.]+$/)?.[0] ?? "";
  const filename =
    extension !== "" && !name.toLowerCase().endsWith(extension.toLowerCase())
      ? `${name}${extension}`
      : name;
  return isOfficeFilename(filename) ? `${parentPath(path).replace(/\/$/, "")}/${filename}` : null;
}

/** Save-as may navigate only to a token-free office route for this same identity. */
export function officeHostTarget(href: string, origin: string, identityId: string): string | null {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) return null;
    const prefix = `/office/${encodeURIComponent(identityId)}/`;
    if (
      !url.pathname.startsWith(prefix) ||
      [...url.searchParams.keys()].some((key) => key !== "mode")
    )
      return null;
    const path = officePathFromSegments(url.pathname.slice(prefix.length).split("/"));
    return officeHref(identityId, path, officeMode(url.searchParams.get("mode") ?? undefined));
  } catch {
    return null;
  }
}
