import type { RunningEnvironment } from "./environment.js";

/**
 * Module-scope handle to the environment `global-setup.ts` started, read by
 * `global-teardown.ts`. Playwright loads both files in the same runner
 * process for a single `playwright test` invocation, so this simple
 * singleton is the primary teardown path; `ENV_STATE_PATH` (a JSON file, see
 * `paths.ts`) is the fallback for anyone stopping the environment from a
 * separate process.
 */
export const registry: { current: RunningEnvironment | null } = { current: null };
