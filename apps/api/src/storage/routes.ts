import { ROUTES, StorageKind, StorageUsageResponse } from "@fdrive/contracts";
import { mimeFromExtension, type StorageProvider } from "@fdrive/core";
import type { IdentityRepo, IndexQueries, LocalUserRepo } from "@fdrive/db";
import type { AuthedHono } from "../app.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { authorizeDuplicateGroups, authorizeIndexedFiles } from "../mcp/handlers.js";
import { reservedExclusionOf, resolveScopeContext } from "../mcp/scope-context.js";
import { createReadAuthorizer } from "../scoping/read-authorizer.js";
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

export interface StorageRoutesDeps {
  readonly identities: Pick<IdentityRepo, "get">;
  readonly resolver: Pick<ScopeResolver, "verifiedIndexScopes">;
  readonly indexQueries: Pick<
    IndexQueries,
    "rootIdsByName" | "bytesByExtension" | "listFiles" | "duplicates"
  >;
  readonly localUsers: Pick<LocalUserRepo, "get">;
  readonly trashPathForStorage: (storage: StorageProvider) => string | null;
}

/**
 * Registers `GET /storage`: how much the signed-in login's own home holds,
 * by kind, against its storage limit, its largest files and its identical
 * files (same size and content hash, empty files left out). Everything
 * comes from the index over the home's verified scope alone, never a folder
 * someone shares with the login; each listed file passes a live read check
 * and fdrive's own folders are left out of the list, though their bytes count.
 */
export function registerStorageRoutes(
  groups: { authed: AuthedHono },
  deps: StorageRoutesDeps,
): void {
  groups.authed.get(withoutApiV1Prefix(ROUTES.storage), async (c) => {
    const principal = c.get("principal");
    const identity = await deps.identities.get(principal.identityId);
    const verified = identity === null ? null : await deps.resolver.verifiedIndexScopes(identity);
    // Only the login's own home: never a folder someone shares with it.
    const home =
      verified?.available === true
        ? verified.scopes.filter((scope) => scope.virtualPrefix === "/")
        : [];
    const ctx = await resolveScopeContext(
      deps.indexQueries,
      home,
      deps.trashPathForStorage(principal.storage),
    );
    const limit =
      identity === null
        ? null
        : ((await deps.localUsers.get(identity.externalUsername))?.storageLimit ?? null);
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
    const authorizer = createReadAuthorizer({ storage: principal.storage });
    const { files, virtualPaths } = await authorizeIndexedFiles(ctx, authorizer, candidates.files);
    const duplicates = await authorizeDuplicateGroups(ctx, authorizer, groups);

    return c.json(
      StorageUsageResponse.parse({
        indexed: true,
        used: extensions.reduce((sum, row) => sum + row.bytes, 0),
        limit,
        kinds: kinds(),
        largest: files.map((file) => ({
          path: virtualPaths.get(file.id),
          size: file.size,
          modifiedAt: dateFromMtimeNs(file.mtimeNs).toISOString(),
        })),
        duplicates: duplicates.groups.map((group) => ({
          size: group.size_bytes,
          paths: group.paths,
        })),
      }),
    );
  });
}
