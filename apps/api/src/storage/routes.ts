import { ROUTES, StorageKind, StorageUsageResponse } from "@fdrive/contracts";
import { mimeFromExtension } from "@fdrive/core";
import type { IndexQueries, LocalUserRepo } from "@fdrive/db";
import type { AuthedHono } from "../app.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { visibleDuplicateGroups } from "../mcp/handlers.js";
import { reservedExclusionOf, resolveScopeContext, virtualPathFor } from "../mcp/scope-context.js";
import type { ScopeResolver } from "../scoping/resolver.js";
import { dateFromMtimeNs } from "../search/scopes.js";

/** How many of the largest files the Storage page lists. */
export const LARGEST_FILES = 25;

/** How many groups of identical files the Storage page lists. */
export const DUPLICATE_GROUPS = 50;

const DOCUMENT_MIME =
  /^(application\/(pdf|rtf|epub\+zip|msword|vnd\.ms-|vnd\.openxmlformats-officedocument|vnd\.oasis\.opendocument)|text\/(plain|markdown|csv|tab-separated-values))/;

/** The kind the Storage page counts a file with extension `ext` (`.jpg`, any case) as. */
export function storageKind(ext: string): StorageKind {
  const mime = mimeFromExtension(ext.toLowerCase()) ?? "";
  if (mime.startsWith("image/")) return "images";
  if (mime.startsWith("video/")) return "videos";
  if (mime.startsWith("audio/")) return "audio";
  return DOCUMENT_MIME.test(mime) ? "documents" : "other";
}

export interface StorageUsageRoutesDeps {
  readonly resolver: Pick<ScopeResolver, "scopesFor">;
  readonly indexQueries: Pick<IndexQueries, "bytesByExtension" | "listFiles" | "duplicates">;
  readonly localUsers: Pick<LocalUserRepo, "get">;
  /** Whether the files folder is indexed now: everything here comes from the index. */
  readonly indexed: () => Promise<boolean>;
}

/**
 * Registers `GET /storage`: how much the signed-in login's own home holds,
 * by kind, against its storage limit, its largest files and its identical
 * files (same size and content hash, empty files left out). Everything
 * comes from the index over the home's scope alone, never a folder someone
 * shares with the login; the scope is the permission, so no storage
 * is read. fdrive's own folders are left out of the list, though their bytes
 * count.
 */
export function registerStorageUsageRoutes(
  groups: { authed: AuthedHono },
  deps: StorageUsageRoutesDeps,
): void {
  groups.authed.get(withoutApiV1Prefix(ROUTES.storage), async (c) => {
    const principal = c.get("principal");
    // Only the login's own home: never a folder someone shares with it.
    const ctx = (await deps.indexed())
      ? resolveScopeContext(
          (await deps.resolver.scopesFor(principal.username)).filter(
            (scope) => scope.virtualPrefix === "/",
          ),
        )
      : null;
    const limit = (await deps.localUsers.get(principal.username))?.storageLimit ?? null;
    const bytes = Object.fromEntries(StorageKind.options.map((kind) => [kind, 0])) as Record<
      StorageKind,
      number
    >;
    const kinds = () => StorageKind.options.map((kind) => ({ kind, bytes: bytes[kind] }));
    if (ctx === null) {
      return c.json(
        StorageUsageResponse.parse({
          indexed: false,
          used: 0,
          limit,
          kinds: kinds(),
          largest: [],
          duplicates: [],
        }),
      );
    }

    const exclude = reservedExclusionOf(ctx);
    const [extensions, candidates, groups] = await Promise.all([
      deps.indexQueries.bytesByExtension(ctx.scopePrefixes),
      deps.indexQueries.listFiles(ctx.scopePrefixes, { exclude }, "size_desc", LARGEST_FILES),
      deps.indexQueries.duplicates(ctx.scopePrefixes, 1, DUPLICATE_GROUPS, { exclude }),
    ]);
    for (const { ext, bytes: total } of extensions) bytes[storageKind(ext)] += total;
    const largest = candidates.files.flatMap((file) => {
      const path = virtualPathFor(ctx, file.path);
      return path === null
        ? []
        : [{ path, size: file.size, modifiedAt: dateFromMtimeNs(file.mtimeNs).toISOString() }];
    });

    return c.json(
      StorageUsageResponse.parse({
        indexed: true,
        used: extensions.reduce((sum, row) => sum + row.bytes, 0),
        limit,
        kinds: kinds(),
        largest,
        duplicates: visibleDuplicateGroups(ctx, groups).groups.map((group) => ({
          size: group.size_bytes,
          paths: group.paths,
        })),
      }),
    );
  });
}
