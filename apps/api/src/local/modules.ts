import { resolve } from "node:path";
import type { Repos } from "@fdrive/db";
import type { AppConfig, IndexRootConfig } from "../config.js";
import { createProviderModules, type ProviderModules } from "../providers/registry.js";
import { createScryptSharePasswords, type SharePasswords } from "../shares/passwords.js";
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
 * Every provider module this deployment has: the local folder over
 * `app.local_users` when `FDRIVE_STORAGE_ROOT` is set, plus WebDAV and S3.
 * The API and the backup worker build theirs the same way.
 */
export function deploymentModules(
  config: Pick<AppConfig, "fdriveStorageRoot" | "fdriveIndexRoots">,
  repos: Pick<Repos, "localUsers" | "localGrants">,
  passwords: SharePasswords = createScryptSharePasswords(),
): ProviderModules {
  const root = config.fdriveStorageRoot;
  if (root === undefined) return createProviderModules();
  return createProviderModules({
    local: {
      root,
      users: createLocalUserStore({ repo: repos.localUsers, grants: repos.localGrants, passwords }),
      indexRoot: localIndexRoot(config.fdriveIndexRoots, root),
    },
  });
}
