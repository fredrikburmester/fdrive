import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the committed `drizzle/` migrations folder relative to a module
 * URL. The migrations folder sits one level above both `src/` (running from
 * source) and `dist/` (running from a build), so `<moduleDir>/../drizzle`
 * resolves correctly either way. Callers pass `import.meta.url` from the
 * module that needs the path.
 */
export function resolveMigrationsFolder(moduleUrl: string): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return path.join(moduleDir, "..", "drizzle");
}
