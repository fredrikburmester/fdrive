import { resolve } from "node:path";
import type { Repos } from "@fdrive/db";
import {
  createFilesFolder,
  createFilesFolderGuard,
  FILES_MARKER,
  type FilesFolder,
  type FilesFolderFacts,
  type FilesFolderGuard,
} from "@fdrive/local";
import type { AppConfig, IndexRootConfig } from "../config.js";
import type { ChangeQueue } from "./change-queue.js";
import { createLocalUsers } from "./users.js";

/** The index root name the local folder has when no configured root names it. */
export const LOCAL_INDEX_ROOT = "files";

/**
 * The index root the local folder is read under: the configured root whose
 * `storagePath` is the folder, else the only root there is, else `files`.
 * A name is needed even when nothing is indexed: Office keys its documents
 * by root and path. Search and thumbnails still need the root configured
 * (`FDRIVE_INDEX_ROOTS`), so a default name enables nothing by itself.
 */
export function localIndexRoot(
  roots: readonly IndexRootConfig[] | null,
  storageRoot: string,
): string {
  if (roots === null) return LOCAL_INDEX_ROOT;
  const folder = resolve(storageRoot);
  const named = roots.find((root) => resolve(root.storagePath) === folder);
  if (named !== undefined) return named.name;
  return roots.length === 1 ? (roots[0] as IndexRootConfig).name : LOCAL_INDEX_ROOT;
}

/**
 * The index root the indexer reads the files folder itself under, and so
 * the root fdrive's changes are journaled under: the configured root whose
 * `storagePath` is the folder, or `null`. Unlike `localIndexRoot` it never
 * guesses, since changes reported under a root that names another folder
 * would carry paths the indexer cannot find.
 */
export function journalRoot(
  roots: readonly IndexRootConfig[] | null,
  storageRoot: string,
): string | null {
  const folder = resolve(storageRoot);
  return roots?.find((root) => resolve(root.storagePath) === folder)?.name ?? null;
}

/**
 * The files folder's row in `app.providers`, created on the first start and
 * found again on every later one. Its id never changes: the Mac app compares
 * it as each location's `providerId`, and Office names it.
 */
export async function ensureStorageRow(repos: Pick<Repos, "providers">): Promise<string> {
  return (await repos.providers.ensure({ type: "local", baseUrl: "local" })).id;
}

export interface DeploymentFilesFolderOptions {
  /** Records every change fdrive makes in the change journal, when the indexer reads the folder itself. */
  readonly changes?: ChangeQueue;
  /** Refuses storage while the folder is not this installation's (`createDeploymentFilesFolderGuard`). */
  readonly guard?: FilesFolderGuard;
}

/**
 * The deployment's files folder, `FDRIVE_STORAGE_ROOT`, over
 * `app.local_users`. The API and the backup worker build theirs the same
 * way.
 */
export function deploymentFilesFolder(
  config: Pick<AppConfig, "fdriveStorageRoot" | "fdriveIndexRoots">,
  repos: Pick<Repos, "localUsers" | "localGrants">,
  options: DeploymentFilesFolderOptions = {},
): FilesFolder {
  const root = config.fdriveStorageRoot;
  const { changes, guard } = options;
  const journaled = changes === undefined ? null : journalRoot(config.fdriveIndexRoots, root);
  return createFilesFolder({
    root,
    users: createLocalUsers({ repo: repos.localUsers, grants: repos.localGrants }),
    // When `journaled` names a root, this is the same one: it matches first.
    indexRoot: localIndexRoot(config.fdriveIndexRoots, root),
    ...(guard === undefined ? {} : { guard }),
    ...(journaled === null || changes === undefined
      ? {}
      : { onIndexChange: (name, change) => changes.record(name, change) }),
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
