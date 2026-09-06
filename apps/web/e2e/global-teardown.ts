import { readFile, rm } from "node:fs/promises";
import { ALICE_STORAGE_STATE_PATH, ENV_STATE_PATH } from "./support/paths.js";
import { registry } from "./support/registry.js";

interface PersistedEnvironmentState {
  readonly apiPid?: number;
  readonly webPid?: number;
}

/** Best-effort `SIGKILL` for a pid, ignoring "no such process" errors. */
function killPidIfAlive(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited, or never existed on this host; nothing to clean up.
  }
}

/**
 * Reads the JSON state `global-setup.ts` persisted and kills any process
 * ids it recorded. Only reached when `registry.current` is unset, i.e. this
 * teardown is running in a different process than the setup that started
 * the environment; Postgres and SFTPGo containers are not stoppable from
 * here (no container id was persisted), so they are left for Testcontainers'
 * own Ryuk reaper to clean up once the setup process that started them
 * exits.
 */
async function stopFromPersistedState(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(ENV_STATE_PATH, "utf-8");
  } catch {
    return;
  }

  const state = JSON.parse(raw) as PersistedEnvironmentState;
  killPidIfAlive(state.apiPid);
  killPidIfAlive(state.webPid);
}

/**
 * Playwright's global teardown: stops everything `global-setup.ts` started.
 * Prefers the in-process handle (the normal case, since Playwright runs
 * setup and teardown in the same runner process); falls back to killing the
 * recorded process ids when that handle is unavailable.
 */
export default async function globalTeardown(): Promise<void> {
  if (registry.current !== null) {
    await registry.current.stop();
    registry.current = null;
  } else {
    await stopFromPersistedState();
  }

  await rm(ENV_STATE_PATH, { force: true });
  await rm(ALICE_STORAGE_STATE_PATH, { force: true });
}
