import { readFile, rm } from "node:fs/promises";
import { getEnvStatePath, getStateDirectory, removeStateDirPointer } from "./support/paths.js";
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
    raw = await readFile(getEnvStatePath(), "utf-8");
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
 * recorded process ids when that handle is unavailable. `getStateDirectory`
 * and `getEnvStatePath` are called here rather than imported as constants
 * deliberately: `support/paths.ts` was already imported once, before
 * `global-setup.ts` resolved this run's actual state directory, by whatever
 * first loaded `playwright.config.ts` in this same process, so a value
 * frozen at that import would still point at the pre-resolution fallback
 * location instead of the real one.
 */
export default async function globalTeardown(): Promise<void> {
  if (registry.current !== null) {
    await registry.current.stop();
    registry.current = null;
  } else {
    await stopFromPersistedState();
  }

  // The whole state directory is this run's own `fs.mkdtemp` directory (see
  // `global-setup.ts`), so removing it recursively is safe and simpler than
  // removing its two known files one at a time.
  await rm(getStateDirectory(), { recursive: true, force: true });
  removeStateDirPointer(process.pid);
}
