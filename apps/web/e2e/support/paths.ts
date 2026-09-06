import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Fixed ports for the e2e stack, deliberately different from the ports the
 * ordinary dev servers use (3000/3001), so this suite never touches a
 * developer's already-running `pnpm dev` processes.
 */
export const E2E_API_PORT = 3901;
export const E2E_WEB_PORT = 3900;
export const E2E_HOST = "127.0.0.1";

export const API_BASE_URL = `http://${E2E_HOST}:${E2E_API_PORT}`;
export const WEB_BASE_URL = `http://${E2E_HOST}:${E2E_WEB_PORT}`;

const STATE_DIR = path.join(tmpdir(), "fdrive-e2e");

/** Where the "setup" project's logged-in-as-alice storage state is written. */
export const ALICE_STORAGE_STATE_PATH = path.join(STATE_DIR, "alice-storage-state.json");

/**
 * Where `global-setup.ts` records the running environment's ports and
 * process ids, so `global-teardown.ts` can find and stop everything even if
 * it runs in a different process than setup did.
 */
export const ENV_STATE_PATH = path.join(STATE_DIR, "environment-state.json");

export const STATE_DIRECTORY = STATE_DIR;
