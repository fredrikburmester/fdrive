import { isSafeSegment, normalizePath } from "@fdrive/core";

/**
 * Object keys for provider paths. A file at `/a/b.txt` under prefix `p` is
 * the key `p/a/b.txt`; the directory `/a` is the key prefix `p/a/`, marked
 * by an empty object at exactly that key when it was created explicitly.
 * The bucket root under an empty prefix is the empty key prefix.
 */

/** The object key for a file at `path`. Throws for the root, which is never a file. */
export function fileKey(prefix: string, path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") throw new Error("the root is not a file");
  const relative = normalized.slice(1);
  return prefix.length === 0 ? relative : `${prefix}/${relative}`;
}

/** The key prefix (with trailing slash) every object under the directory `path` starts with. */
export function dirKey(prefix: string, path: string): string {
  const normalized = normalizePath(path);
  const base = prefix.length === 0 ? "" : `${prefix}/`;
  return normalized === "/" ? base : `${base}${normalized.slice(1)}/`;
}

/**
 * The single name a key returned for a directory listing denotes, or `null`
 * when the key is the directory's own marker, sits deeper than one level, or
 * is not a name fdrive can show as a path segment. Keys outside `parent` are
 * `null` too: a server that returns extra rows is ignored, never followed.
 */
export function childName(parent: string, key: string): string | null {
  if (!key.startsWith(parent)) return null;
  const rest = key.slice(parent.length);
  const name = rest.endsWith("/") ? rest.slice(0, -1) : rest;
  if (name.length === 0 || name.includes("/") || !isSafeSegment(name)) return null;
  return name;
}

/** `x-amz-copy-source` for a key: the bucket and each key segment percent-encoded. */
export function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}
