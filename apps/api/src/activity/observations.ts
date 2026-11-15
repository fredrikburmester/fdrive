import { isStorageError } from "@fdrive/core";
import type { ActivityObservationsRepo, IdentityRepo } from "@fdrive/db";
import type { IdentityStorageFactory } from "../auth/storage-factory.ts";
import type { IndexerEventPayload } from "../events/indexer-listener.js";
import type { ScopeResolver } from "../scoping/resolver.ts";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";

/**
 * Turns the indexer's change notifications into Unknown observations of files
 * the owner already tracks. Nothing else observes changes made outside fdrive.
 * A path counts when it maps through the login's scopes; storage is read only
 * for what the observation records (a file's kind, size and time).
 */
export function createActivityObservations(deps: {
  repo: ActivityObservationsRepo;
  identities: IdentityRepo;
  storageFactory: IdentityStorageFactory;
  resolver: Pick<ScopeResolver, "scopesFor">;
}) {
  async function observeAbsentSubtree(
    actor: { accountId: string; identityId: string },
    path: string,
    kind: "missing" | "left_scope",
  ) {
    let cursor: string | undefined;
    do {
      const files = await deps.repo.tracked(actor.accountId, actor.identityId, path, cursor);
      for (const file of files) {
        cursor = file.id;
        await deps.repo.observe({
          ...actor,
          path: file.path,
          kind,
          source: "indexer",
          evidence: kind === "left_scope" ? "watcher_move" : "watcher_change",
        });
      }
      if (files.length < 100) break;
    } while (cursor);
  }
  return {
    async tracks(identityId: string, path: string) {
      const identity = await deps.identities.get(identityId);
      return (
        !!identity && (await deps.repo.tracked(identity.accountId, identityId, path)).length > 0
      );
    },
    async relink(identityId: string, path: string, candidate: string) {
      const identity = await deps.identities.get(identityId);
      if (!identity) return;
      await deps.repo.observe({
        accountId: identity.accountId,
        identityId,
        path,
        kind: "continuity_unknown",
        source: "indexer",
        evidence: "sha256_relink",
        after: { targetPath: candidate },
      });
    },
    async watcher(identityId: string, event: IndexerEventPayload) {
      const identity = await deps.identities.get(identityId);
      if (!identity) return;
      const scopes = await deps.resolver.scopesFor(identity.externalUsername);
      const path = roundTripVirtualPath(scopes, event.path);
      if (!path) return;
      const storage = await deps.storageFactory(identityId);
      const actor = { accountId: identity.accountId, identityId };
      const target = event.target_path ? roundTripVirtualPath(scopes, event.target_path) : null;
      if (event.kind === "moved" && target) {
        const stat = await storage.stat(target);
        let cursor: string | undefined;
        do {
          const tracked = await deps.repo.tracked(actor.accountId, identityId, path, cursor);
          for (const file of tracked) {
            cursor = file.id;
            const destination = target + file.path.slice(path.length);
            const next = destination === target ? stat : await storage.stat(destination);
            const nextKind = next.kind === "dir" ? "dir" : "file";
            await deps.repo.observe({
              ...actor,
              path: file.path,
              kind: "moved",
              source: "indexer",
              evidence: "watcher_move",
              after: {
                path: destination,
                kind: nextKind,
                size: next.size,
                modifiedAt: next.modifiedAt?.toISOString() ?? null,
              },
            });
          }
          if (tracked.length < 100) break;
        } while (cursor);
      } else if (event.kind === "moved" && event.target_path) {
        await observeAbsentSubtree(actor, path, "left_scope");
      } else if (event.kind === "deleted") {
        try {
          await storage.stat(path);
          return;
        } catch (error) {
          if (!isStorageError(error) || error.kind !== "not_found") return;
        }
        try {
          await storage.list(path.slice(0, path.lastIndexOf("/")) || "/");
        } catch {
          return;
        }
        await observeAbsentSubtree(actor, path, "missing");
      } else {
        const stat = await storage.stat(path);
        const kind = stat.kind === "dir" ? "dir" : "file";
        await deps.repo.observe({
          ...actor,
          path,
          kind: "present",
          source: "indexer",
          evidence: "watcher_change",
          after: {
            path,
            kind,
            size: stat.size,
            modifiedAt: stat.modifiedAt?.toISOString() ?? null,
          },
        });
      }
    },
  };
}
export type ActivityObservations = ReturnType<typeof createActivityObservations>;
