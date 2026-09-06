/**
 * Minimal stand-in for the shell chunk's `src/lib/api/keys.ts`. `deps.ts`
 * re-exports this until the integration chunk repoints it at the real
 * module. The shape matches the spec exactly: `queryKeys.fs.list(path)`.
 */
export const queryKeys = {
  fs: {
    list: (path: string) => ["fs", "list", path] as const,
  },
} as const;
