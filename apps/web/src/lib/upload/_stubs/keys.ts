/**
 * Stand-in for the shell's TanStack Query key factory (owned by another
 * chunk, `src/lib/api/keys.ts`). Only the shape the upload queue depends on
 * is reproduced here: a stable, serializable key for a directory listing.
 * `deps.ts` re-exports this; the integration chunk repoints that re-export
 * at the real module and this file can then be deleted.
 */
export const queryKeys = {
  fs: {
    list: (path: string) => ["fs", "list", path] as const,
  },
} as const;

export type QueryKeys = typeof queryKeys;
