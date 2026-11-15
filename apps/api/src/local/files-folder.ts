import { randomUUID } from "node:crypto";
import type { Repos, SettingsRepo } from "@fdrive/db";
import {
  createFilesFolder,
  createFilesFolderGuard,
  FILES_MARKER,
  type FilesFolder,
  type FilesFolderFacts,
  type FilesFolderGuard,
} from "@fdrive/local";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { HomeUsage } from "../storage/usage.js";
import type { ChangeQueue } from "./change-queue.js";
import { createLocalUsers } from "./users.js";

/** The `app.settings` key of the files folder's id. */
export const STORAGE_ID_SETTINGS_KEY = "storage.id";

const StoredId = z.object({ id: z.uuid() });

/**
 * The files folder's id, created on the first start and read on every later
 * one. It never changes: the Mac app compares it as each location's
 * `providerId`, and a new one would have every Mac paired again. A server
 * from before migration 0045 keeps the id of its old `app.providers` row.
 */
export async function ensureStorageId(
  settings: Pick<SettingsRepo, "get" | "compareAndSet">,
): Promise<string> {
  await settings.compareAndSet(STORAGE_ID_SETTINGS_KEY, null, { id: randomUUID() });
  return StoredId.parse(await settings.get(STORAGE_ID_SETTINGS_KEY)).id;
}

export interface DeploymentFilesFolderOptions {
  /** Records every change fdrive makes in the change journal. */
  readonly changes?: ChangeQueue;
  /** Refuses storage while the folder is not this installation's (`createDeploymentFilesFolderGuard`). */
  readonly guard?: FilesFolderGuard;
  /** Names each new Trash leaf by the time it was made. */
  readonly clock?: () => Date;
  /**
   * What each user's folder holds: with it, a write its folder's owner has
   * no room for under their storage limit is refused.
   */
  readonly usage?: HomeUsage;
}

/**
 * The deployment's files folder, `FDRIVE_STORAGE_ROOT`, over
 * `app.local_users`. The API and the backup worker build theirs the same
 * way.
 */
export function deploymentFilesFolder(
  config: Pick<AppConfig, "fdriveStorageRoot">,
  repos: Pick<Repos, "localUsers" | "localGrants">,
  options: DeploymentFilesFolderOptions = {},
): FilesFolder {
  const { changes, guard, clock, usage } = options;
  return createFilesFolder({
    root: config.fdriveStorageRoot,
    users: createLocalUsers({
      repo: repos.localUsers,
      grants: repos.localGrants,
      ...(usage === undefined ? {} : { usage }),
    }),
    ...(guard === undefined ? {} : { guard }),
    ...(clock === undefined ? {} : { clock }),
    ...(changes === undefined ? {} : { onIndexChange: (change) => changes.record(change) }),
  });
}

export interface FilesFolderLog {
  info(message: string): void;
  error(message: string): void;
}

/**
 * The guard over the deployment's files folder, logging each change of
 * verdict: a refusal loudly, since every file route fails until the folder
 * is fixed, and an adoption or recovery once.
 */
export function createDeploymentFilesFolderGuard(
  root: string,
  facts: FilesFolderFacts,
  log: FilesFolderLog,
): FilesFolderGuard {
  return createFilesFolderGuard({
    root,
    facts,
    onChange: (verdict) => {
      if (!verdict.ok) {
        log.error(
          `files folder ${root} refused: ${verdict.reason} Files stay unavailable and nothing is indexed until it is fixed; fdrive checks again on the next request.`,
        );
      } else if (verdict.adopted) {
        log.info(`files folder ${root} adopted: wrote ${FILES_MARKER} with this installation's id`);
      } else {
        log.info(`files folder ${root} verified`);
      }
    },
  });
}

/** The core subsystem's health from the guard: a refusal fails it with the reason. */
export async function filesFolderHealth(
  guard: FilesFolderGuard,
): Promise<true | { readonly failed: string }> {
  const verdict = await guard.verify();
  return verdict.ok ? true : { failed: verdict.reason };
}
