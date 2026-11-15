import type { EntryStat, StorageProvider } from "@fdrive/core";
import type { ActivityObservationsRepo } from "@fdrive/db";

/** Whose history an observation goes to: the login's account, and the login. */
export interface ObservationActor {
  readonly accountId: string;
  readonly identityId: string;
}

/**
 * Turns changes made outside fdrive (rows the watcher, a scan or OCR wrote
 * in the change journal) into Unknown observations of files the owner
 * already tracks; the repository ignores every other path. Paths are the
 * login's own; storage is read only for what an observation records (a
 * file's kind, size and time).
 */
export function createActivityObservations(deps: {
  repo: Pick<ActivityObservationsRepo, "observe" | "tracked">;
}) {
  /** Each tracked file at or below `path`, a page of 100 at a time. */
  async function eachTracked(
    actor: ObservationActor,
    path: string,
    visit: (file: { path: string }) => Promise<void>,
  ) {
    let cursor: string | undefined;
    do {
      const files = await deps.repo.tracked(actor.accountId, actor.identityId, path, cursor);
      for (const file of files) {
        cursor = file.id;
        await visit(file);
      }
      if (files.length < 100) break;
    } while (cursor);
  }

  return {
    /** `from` moved to `to`, both in the login's files: each tracked file below follows. */
    async moved(actor: ObservationActor, storage: StorageProvider, from: string, to: string) {
      const stat = await storage.stat(to);
      await eachTracked(actor, from, async (file) => {
        const destination = to + file.path.slice(from.length);
        const next = destination === to ? stat : await storage.stat(destination);
        await deps.repo.observe({
          ...actor,
          path: file.path,
          kind: "moved",
          source: "indexer",
          evidence: "watcher_move",
          after: {
            path: destination,
            kind: next.kind === "dir" ? "dir" : "file",
            size: next.size,
            modifiedAt: next.modifiedAt?.toISOString() ?? null,
          },
        });
      });
    },
    /** What was at or below `path` is gone, or moved out of the login's files. */
    async absent(actor: ObservationActor, path: string, kind: "missing" | "left_scope") {
      await eachTracked(actor, path, (file) =>
        deps.repo
          .observe({
            ...actor,
            path: file.path,
            kind,
            source: "indexer",
            evidence: kind === "left_scope" ? "watcher_move" : "watcher_change",
          })
          .then(() => undefined),
      );
    },
    /** Something is at `path` now, as `stat` shows it; a tracked file there is compared. */
    async present(actor: ObservationActor, path: string, stat: EntryStat) {
      await deps.repo.observe({
        ...actor,
        path,
        kind: "present",
        source: "indexer",
        evidence: "watcher_change",
        after: {
          path,
          kind: stat.kind === "dir" ? "dir" : "file",
          size: stat.size,
          modifiedAt: stat.modifiedAt?.toISOString() ?? null,
        },
      });
    },
  };
}
export type ActivityObservations = ReturnType<typeof createActivityObservations>;
