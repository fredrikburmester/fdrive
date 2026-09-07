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
  system: {
    indexer: () => ["system", "indexer"] as const,
    search: () => ["system", "search"] as const,
    ocr: () => ["system", "ocr"] as const,
    thumbnails: () => ["system", "thumbnails"] as const,
  },
  account: {
    tokens: () => ["account", "tokens"] as const,
    favorites: (accountId: string) => ["account", accountId, "favorites"] as const,
  },
  tags: {
    list: () => ["tags", "list"] as const,
    files: (id: string) => ["tags", "files", id] as const,
  },
  favorites: {
    list: () => ["favorites", "list"] as const,
  },
  recents: {
    list: () => ["recents", "list"] as const,
  },
} as const;
