import type { AccountFavoritesResponse } from "@fdrive/contracts";
import { isStorageError, type StorageProvider } from "@fdrive/core";
import type { Identity } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";
import { statEntry } from "../fs/routes.js";
import { liveAccountSession } from "./service.ts";
import type { AccountRequestContext, AccountsDeps } from "./types.ts";

/** Each lane awaits its work, keeping total upstream fanout at four operations. */
export async function mapAccountIdentities<T>(
  identities: readonly Identity[],
  operation: (identity: Identity) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, identities.length) }, async () => {
      for (;;) {
        const index = next++;
        const identity = identities[index];
        if (identity === undefined) return;
        results[index] = await operation(identity);
      }
    }),
  );
  return results;
}
function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function partialFailure(error: unknown): boolean {
  return (
    isStorageError(error) ||
    (error instanceof ApiHttpError &&
      [
        "forbidden",
        "not_found",
        "unauthorized",
        "reauth_required",
        "upstream_unavailable",
        "setup_required",
      ].includes(error.kind))
  );
}
export function createAccountViews(deps: AccountsDeps) {
  async function identities(input: AccountRequestContext) {
    const session = await liveAccountSession(deps, input);
    return (await deps.repos.identities.listByAccount(session.accountId)).sort((a, b) =>
      order(a.id, b.id),
    );
  }
  async function owned(identity: Identity, accountId: string) {
    const current = await deps.repos.identities.get(identity.id);
    if (current?.accountId !== accountId)
      throw new ApiHttpError("forbidden", "identity ownership changed");
  }
  async function permission(
    storage: StorageProvider,
    path: string,
    kind: "file" | "dir" | "symlink" | "other",
  ) {
    if (kind === "dir" && path === "/") {
      // The virtual root has no parent entry. Listing it proves access directly.
      await storage.list(path);
      return;
    }
    const stat = await statEntry(storage, path);
    if (stat.kind !== kind) throw new ApiHttpError("not_found", "entry changed");
    // A parent listing does not prove permission to enter the directory itself.
    if (kind === "dir") await storage.list(path);
  }
  return {
    async favorites(input: AccountRequestContext): Promise<AccountFavoritesResponse> {
      const rows = await mapAccountIdentities(await identities(input), async (identity) => {
        try {
          await owned(identity, input.principal.accountId);
          const storage = await deps.storageForIdentity(identity);
          const favorites = (await deps.repos.favorites.list(identity.id)).sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || order(a.path, b.path),
          );
          const items: AccountFavoritesResponse["items"] = [];
          const seen = new Set<string>();
          for (const item of favorites) {
            if (seen.has(item.path)) continue;
            seen.add(item.path);
            await permission(storage, item.path, item.kind);
            items.push({
              identityId: identity.id,
              path: item.path,
              kind: item.kind,
              addedAt: item.createdAt.toISOString(),
            });
            if (items.length >= 1000) break;
          }
          await owned(identity, input.principal.accountId);
          return { identityId: identity.id, items, unavailable: false };
        } catch (error) {
          if (!partialFailure(error)) throw error;
          return { identityId: identity.id, items: [], unavailable: true };
        }
      });
      return {
        items: rows
          .flatMap((row) => row.items)
          .sort(
            (a, b) =>
              order(b.addedAt, a.addedAt) ||
              order(a.identityId, b.identityId) ||
              order(a.path, b.path),
          )
          .slice(0, 1000),
        unavailableIdentityIds: rows.filter((row) => row.unavailable).map((row) => row.identityId),
      };
    },
  };
}
export type AccountViews = ReturnType<typeof createAccountViews>;
