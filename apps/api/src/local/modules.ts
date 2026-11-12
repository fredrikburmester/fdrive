import { resolve } from "node:path";
import type { Repos } from "@fdrive/db";
import type { AppConfig, IndexRootConfig } from "../config.js";
import { createProviderModules, type ProviderModules } from "../providers/registry.js";
import { createScryptSharePasswords, type SharePasswords } from "../shares/passwords.js";
import { createLocalUserStore } from "./users.js";

/**
 * The index root the local folder is read under: the configured root whose
 * `storagePath` is the folder, else the only root there is. `null` when
 * the deployment indexes nothing.
 */
export function localIndexRoot(
  roots: readonly IndexRootConfig[] | null,
  storageRoot: string,
): string | null {
  if (roots === null) return null;
  const folder = resolve(storageRoot);
  const named = roots.find((root) => resolve(root.storagePath) === folder);
  if (named !== undefined) return named.name;
  return roots.length === 1 ? (roots[0]?.name ?? null) : null;
}

/**
 * Every provider module this deployment has: the local folder over
 * `app.local_users` when `FDRIVE_STORAGE_ROOT` is set, plus WebDAV and S3.
 * The API and the backup worker build theirs the same way.
 */
export function deploymentModules(
  config: Pick<AppConfig, "fdriveStorageRoot" | "fdriveIndexRoots">,
  repos: Pick<Repos, "localUsers">,
  passwords: SharePasswords = createScryptSharePasswords(),
): ProviderModules {
  const root = config.fdriveStorageRoot;
  if (root === undefined) return createProviderModules();
  return createProviderModules({
    local: {
      root,
      users: createLocalUserStore({ repo: repos.localUsers, passwords }),
      indexRoot: localIndexRoot(config.fdriveIndexRoots, root),
    },
  });
}
