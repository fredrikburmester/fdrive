import { type FileEntry, isStorageError } from "@fdrive/core";
import type { ActivityObservationsRepo, IdentityRepo } from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import type { IdentityStorageFactory } from "../auth/storage-factory.ts";
import type { IndexerEventPayload } from "../events/indexer-listener.js";
import { createReadAuthorizer } from "../scoping/read-authorizer.ts";
import type { ScopeResolver } from "../scoping/resolver.ts";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";

export function createActivityObservations(deps: {
  repo: ActivityObservationsRepo;
  identities: IdentityRepo;
  storageFactory: IdentityStorageFactory;
  resolver: Pick<ScopeResolver, "configuredMappings">;
  onError: (error: unknown) => void;
}) {
  const refreshCursors = new Map<string, string>();
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
  async function check(principal: Principal, path: string) {
    try {
      const stat = await principal.storage.stat(path);
      const kind = stat.kind === "dir" ? "dir" : "file";
      const read = await createReadAuthorizer({ storage: principal.storage }).authorize({
        path,
        kind,
      });
      if (!read.allowed) return { checked: false };
      await deps.repo.observe({
        accountId: principal.accountId,
        identityId: principal.identityId,
        path,
        kind: "present",
        source: "refresh",
        evidence: "refresh_comparison",
        after: { path, kind, size: stat.size, modifiedAt: stat.modifiedAt?.toISOString() ?? null },
      });
      return { checked: true };
    } catch (error) {
      if (!isStorageError(error) || error.kind !== "not_found") return { checked: false };
      // A missing child is evidence only while its parent can still be read.
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      try {
        await principal.storage.list(parent);
      } catch {
        return { checked: false };
      }
      await deps.repo.observe({
        accountId: principal.accountId,
        identityId: principal.identityId,
        path,
        kind: "missing",
        source: "refresh",
        evidence: "refresh_comparison",
      });
      return { checked: true };
    }
  }
  return {
    check,
    async refresh(principal: Principal, parent: string, completeEntries: readonly FileEntry[]) {
      // Rotate a bounded page and live-check only changed candidates. A successful
      // full listing suggests differences; only check() can establish a discrepancy.
      try {
        const key = JSON.stringify([principal.accountId, principal.identityId, parent]);
        const tracked = await deps.repo.children(
          principal.accountId,
          principal.identityId,
          parent,
          refreshCursors.get(key),
        );
        const entries = new Map(completeEntries.map((entry) => [entry.path, entry]));
        let checks = 0;
        for (const file of tracked) {
          const entry = entries.get(file.path);
          const unchanged =
            entry &&
            file.state === "live" &&
            file.fingerprint ===
              `stat:${JSON.stringify([entry.size, entry.modifiedAt.toISOString()])}`;
          if (!unchanged) {
            await check(principal, file.path);
            checks++;
          }
          refreshCursors.set(key, file.id);
          if (checks === 8) break;
        }
        if (tracked.length < 100 && checks < 8) refreshCursors.delete(key);
        if (refreshCursors.size > 2000) refreshCursors.clear();
      } catch (error) {
        deps.onError(error);
      }
    },
    async tracks(identityId: string, path: string) {
      const identity = await deps.identities.get(identityId);
      return (
        !!identity && (await deps.repo.tracked(identity.accountId, identityId, path)).length > 0
      );
    },
    async relink(identityId: string, path: string, candidate: string) {
      const identity = await deps.identities.get(identityId);
      if (!identity) return;
      const storage = await deps.storageFactory(identityId);
      if (
        !(await createReadAuthorizer({ storage }).authorize({ path: candidate, kind: "file" }))
          .allowed
      )
        return;
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
      const mappings = await deps.resolver.configuredMappings(identity);
      if (!mappings.available) return;
      const path = roundTripVirtualPath(mappings.scopes, event.root, event.path);
      if (!path) return;
      const storage = await deps.storageFactory(identityId);
      const actor = { accountId: identity.accountId, identityId };
      const target = event.target_path
        ? roundTripVirtualPath(mappings.scopes, event.root, event.target_path)
        : null;
      if (event.kind === "moved" && target) {
        const stat = await storage.stat(target);
        const kind = stat.kind === "dir" ? "dir" : "file";
        if (!(await createReadAuthorizer({ storage }).authorize({ path: target, kind })).allowed)
          return;
        let cursor: string | undefined;
        do {
          const tracked = await deps.repo.tracked(actor.accountId, identityId, path, cursor);
          for (const file of tracked) {
            cursor = file.id;
            const destination = target + file.path.slice(path.length);
            const next = destination === target ? stat : await storage.stat(destination);
            const nextKind = next.kind === "dir" ? "dir" : "file";
            if (
              !(
                await createReadAuthorizer({ storage }).authorize({
                  path: destination,
                  kind: nextKind,
                })
              ).allowed
            )
              continue;
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
        if (!(await createReadAuthorizer({ storage }).authorize({ path, kind })).allowed) return;
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
