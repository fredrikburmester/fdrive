import { startEnvironment } from "./support/environment.js";
import { registry } from "./support/registry.js";

/**
 * Playwright's global setup: boots Postgres, SFTPGo, the API, and the web
 * app once for the whole run (see `support/environment.ts`), and stashes
 * the handle for `global-teardown.ts`. Never used to seed per-test data;
 * each spec creates the folders and files it needs through the UI, under
 * unique names, so tests stay independent of each other.
 */
export default async function globalSetup(): Promise<void> {
  registry.current = await startEnvironment();
}
