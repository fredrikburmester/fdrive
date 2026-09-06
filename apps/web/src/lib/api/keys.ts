/**
 * Query key factory for TanStack Query. Every hook and invalidation call in
 * `apps/web` goes through these functions so the keys stay consistent
 * across chunks; do not build fs/auth query keys by hand elsewhere.
 */
export const queryKeys = {
  auth: {
    me: () => ["auth", "me"] as const,
  },
  fs: {
    list: (path: string) => ["fs", "list", path] as const,
    stat: (path: string) => ["fs", "stat", path] as const,
  },
  setup: {
    status: () => ["setup", "status"] as const,
  },
  admin: {
    connection: () => ["admin", "connection"] as const,
  },
  account: {
    tokens: () => ["account", "tokens"] as const,
  },
} as const;
