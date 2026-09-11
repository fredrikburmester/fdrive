/**
 * Chunking for metadata lookups that bind one parameter per path.
 *
 * A directory listing is unbounded: `StorageProvider.list` takes no limit, the
 * SFTPGo provider returns every entry, and `fs.list` hands all of them to the
 * metadata service. Files can also arrive outside fdrive over raw SFTP or
 * WebDAV, so a directory can hold more entries than one statement may bind.
 * Lookups keyed by that path list go through `selectPathChunks` so no single
 * statement can exceed the protocol's parameter limit.
 */

/**
 * PostgreSQL's extended-query protocol carries a 16-bit bound-parameter count.
 * node-postgres writes that count without checking it, so a statement past the
 * cap does not fail cleanly: the Bind message declares a wrapped-around count
 * and the server sees a malformed message.
 */
const MAX_BIND_PARAMETERS = 65_535;

/** Every chunked lookup also binds `identity_id` beside the path list. */
const RESERVED_BIND_PARAMETERS = 1;

/**
 * Paths bound into one `path in (...)` statement: a sixteenth of the remaining
 * budget (`(65535 - 1) / 16`). The margin is deliberate — the driver's count
 * already wraps above 32767, and these queries may gain further predicates —
 * and it keeps a wide `in (...)` list cheap to plan. Ordinary listings are
 * orders of magnitude smaller and still run as a single query.
 */
export const PATH_CHUNK_SIZE = Math.floor((MAX_BIND_PARAMETERS - RESERVED_BIND_PARAMETERS) / 16);

/**
 * Runs `select` over `paths` in chunks that fit one statement and returns
 * every row it produced, in chunk order.
 *
 * An empty list runs no query at all, and a list that already fits runs
 * exactly one query with the paths unchanged, so an ordinary listing keeps the
 * single round trip it has always made. Chunks run one at a time rather than
 * concurrently, so a pathologically large directory cannot claim the whole
 * connection pool for one listing.
 */
export async function selectPathChunks<Row>(
  paths: readonly string[],
  select: (chunk: string[]) => PromiseLike<Row[]>,
): Promise<Row[]> {
  if (paths.length === 0) {
    return [];
  }
  if (paths.length <= PATH_CHUNK_SIZE) {
    return select([...paths]);
  }
  // `in (...)` matches a row once however often its path appears, so the
  // chunked form must not list one path in two chunks and collect its rows
  // twice. Deduplicating here costs nothing on the single-chunk path above.
  const unique = [...new Set(paths)];
  const rows: Row[] = [];
  for (let start = 0; start < unique.length; start += PATH_CHUNK_SIZE) {
    for (const row of await select(unique.slice(start, start + PATH_CHUNK_SIZE))) {
      rows.push(row);
    }
  }
  return rows;
}
