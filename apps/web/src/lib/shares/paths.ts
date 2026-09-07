import { ShareId, SharePath, ShareUploadPath } from "@fdrive/contracts";

export function publicShareHref(id: string, path = "/"): string {
  ShareId.parse(id);
  SharePath.parse(path);
  return `/s/${id}${path === "/" ? "" : `?path=${encodeURIComponent(path)}`}`;
}

/** Names are already decoded by the API. A literal percent sign remains literal. */
export function appendShareName(path: string, name: string): string {
  SharePath.parse(path);
  if (!name || name.includes("/")) throw new Error("Invalid shared filename.");
  return SharePath.parse(`${path === "/" ? "" : path}/${name}`);
}

export function shareBreadcrumbs(path: string): { name: string; path: string }[] {
  SharePath.parse(path);
  const result = [{ name: "Shared files", path: "/" }];
  if (path === "/") return result;
  const segments = path.slice(1).split("/");
  for (let index = 0; index < segments.length; index++) {
    const name = segments[index];
    if (name !== undefined)
      result.push({ name, path: `/${segments.slice(0, index + 1).join("/")}` });
  }
  return result;
}

export function publicUploadPath(name: string): string {
  return ShareUploadPath.parse(appendShareName("/", name));
}
