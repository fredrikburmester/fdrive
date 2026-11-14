import { resolve } from "node:path";
import type { Repos } from "@fdrive/db";
import type { FilesFolderGuard } from "@fdrive/local";
import type { AppConfig, IndexRootConfig } from "../config.js";
import { createProviderModules, type ProviderModules } from "../providers/registry.js";
import { createScryptSharePasswords, type SharePasswords } from "../shares/passwords.js";
import type { ChangeQueue } from "./change-queue.js";
import { createLocalUserStore } from "./users.js";

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
 * Every provider module this deployment has: the files folder over
 * `app.local_users` when `FDRIVE_STORAGE_ROOT` is set, else none. The API
 * and the backup worker build theirs the same way. With `changes`, every
 * change fdrive makes in the folder is recorded in the change journal, when
 * the indexer reads the folder itself (`journalRoot`). With `guard`, storage
 * is refused while the folder is not this installation's
 * (`createDeploymentFilesFolderGuard`).
 */
export function deploymentModules(
  config: Pick<AppConfig, "fdriveStorageRoot" | "fdriveIndexRoots">,
  repos: Pick<Repos, "localUsers" | "localGrants">,
  passwords: SharePasswords = createScryptSharePasswords(),
  changes?: ChangeQueue,
  guard?: FilesFolderGuard,
): ProviderModules {
  const root = config.fdriveStorageRoot;
  if (root === undefined) return createProviderModules();
  const journaled = changes === undefined ? null : journalRoot(config.fdriveIndexRoots, root);
  return createProviderModules({
    local: {
      root,
      users: createLocalUserStore({ repo: repos.localUsers, grants: repos.localGrants, passwords }),
      // When `journaled` names a root, this is the same one: it matches first.
      indexRoot: localIndexRoot(config.fdriveIndexRoots, root),
      ...(guard === undefined ? {} : { guard }),
      ...(journaled === null || changes === undefined
        ? {}
        : { onIndexChange: (name, change) => changes.record(name, change) }),
    },
  });
}
