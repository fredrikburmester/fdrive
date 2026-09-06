/**
 * Stand-in for `src/lib/api/keys.ts`, which another chunk builds in
 * parallel. Only the two query keys this chunk needs are implemented;
 * `deps.ts` re-exports this so the integration chunk can repoint one
 * import once the real module lands.
 */
export const queryKeys = {
  fs: {
    list: (path: string) => ["fs", "list", path] as const,
    stat: (path: string) => ["fs", "stat", path] as const,
  },
} as const;
