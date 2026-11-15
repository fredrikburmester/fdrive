import type { IndexQueries } from "@fdrive/db";
import type { AppConfig } from "../config.js";
import { localIndexRoot } from "../local/modules.js";

/** The bytes in a user's home folder as the index counts them; `null` while it is not indexed. */
export type HomeUsage = (username: string) => Promise<number | null>;

/**
 * Every byte the index holds under `<root>/<username>`, Trash included: what
 * a storage limit counts, and what System > Users shows. `null` when the
 * files folder's index root is not configured or the indexer has not
 * created it yet.
 */
export function createHomeUsage(
  config: Pick<AppConfig, "fdriveStorageRoot" | "fdriveIndexRoots">,
  index: Pick<IndexQueries, "rootIdsByName" | "subtreeSize">,
): HomeUsage {
  const storageRoot = config.fdriveStorageRoot;
  const name =
    storageRoot === undefined ? null : localIndexRoot(config.fdriveIndexRoots, storageRoot);
  const rootName = (config.fdriveIndexRoots ?? []).some((root) => root.name === name) ? name : null;
  return async (username) => {
    if (rootName === null) return null;
    const rootId = (await index.rootIdsByName())[rootName];
    if (rootId === undefined) return null;
    const home = [{ rootId, fsPrefix: `/${username}` }];
    return (await index.subtreeSize(home, rootId, username)).bytes;
  };
}
