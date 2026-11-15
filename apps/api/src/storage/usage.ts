import { INDEX_ROOT_ID, type IndexQueries } from "@fdrive/db";

/** The bytes in a user's home folder as the index counts them; `null` while it is not indexed. */
export type HomeUsage = (username: string) => Promise<number | null>;

/**
 * Every byte the index holds under `<root>/<username>`, Trash included: what
 * a storage limit counts, and what System > Users shows. `null` while the
 * files folder is not indexed (`indexed`).
 */
export function createHomeUsage(
  index: Pick<IndexQueries, "subtreeSize">,
  indexed: () => Promise<boolean>,
): HomeUsage {
  return async (username) => {
    if (!(await indexed())) return null;
    const home = [{ rootId: INDEX_ROOT_ID, fsPrefix: `/${username}` }];
    return (await index.subtreeSize(home, INDEX_ROOT_ID, username)).bytes;
  };
}
