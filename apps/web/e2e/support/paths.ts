import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const E2E_HOST = "127.0.0.1";

/**
 * Fallback ports, only ever actually used before `global-setup.ts` has run:
 * Playwright loads `playwright.config.ts` (which imports this module) once
 * in its main process just to discover `globalSetup`'s location, before
 * `globalSetup` gets a chance to resolve real ports (see
 * `support/ports.ts`) and write them onto `process.env`. That first,
 * "too early" resolution is discarded; every worker process reloads this
 * config fresh, after `globalSetup` has completed and after the resolved
 * ports have been inherited through `process.env` (workers are forked
 * children of the same process that ran `globalSetup`), so by the time a
 * `baseURL` or `storageState` path is actually used by a test, it reflects
 * the real, resolved values below.
 */
const FALLBACK_API_PORT = 3901;
const FALLBACK_WEB_PORT = 3900;

function portFromEnv(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`fdrive e2e: ${envVar}="${raw}" is not a valid port number`);
  }
  return parsed;
}

/** The API's port for this run: `E2E_API_PORT` once `global-setup.ts` has resolved and exported it, otherwise the fallback above. */
export function getApiPort(): number {
  return portFromEnv("E2E_API_PORT", FALLBACK_API_PORT);
}

/** The web app's port for this run: `E2E_WEB_PORT` once `global-setup.ts` has resolved and exported it, otherwise the fallback above. */
export function getWebPort(): number {
  return portFromEnv("E2E_WEB_PORT", FALLBACK_WEB_PORT);
}

export function getApiBaseUrl(): string {
  return `http://${E2E_HOST}:${getApiPort()}`;
}

export function getWebBaseUrl(): string {
  return `http://${E2E_HOST}:${getWebPort()}`;
}

const PENDING_STATE_DIR = path.join(tmpdir(), "fdrive-e2e-pending");

function stateDirPointerPath(pid: number): string {
  return path.join(tmpdir(), `fdrive-e2e-state-dir.${pid}.pointer`);
}

/**
 * Reads the state directory `global-setup.ts` (running with pid `pid`)
 * recorded for its run, for a process that needs it but did not inherit
 * `E2E_STATE_DIR` through `process.env` (normally every process does,
 * since Playwright forks workers with the setup process's current
 * environment, but this is a defensive fallback in case that ever changes).
 */
export function readStateDirPointer(pid: number): string | undefined {
  try {
    const contents = readFileSync(stateDirPointerPath(pid), "utf-8").trim();
    return contents.length > 0 ? contents : undefined;
  } catch {
    return undefined;
  }
}

/** Records `stateDir` for `pid` (the calling process's own pid), so a process that is not this one but is a direct child of it (a forked worker) can find it via `readStateDirPointer(process.ppid)` if `E2E_STATE_DIR` did not make it into its environment. */
export function writeStateDirPointer(pid: number, stateDir: string): void {
  writeFileSync(stateDirPointerPath(pid), stateDir, "utf-8");
}

/** Removes the pointer file written by `writeStateDirPointer` for `pid`. Safe to call even if it was never written. */
export function removeStateDirPointer(pid: number): void {
  try {
    unlinkSync(stateDirPointerPath(pid));
  } catch {
    // Already gone, or never existed on this host; nothing to clean up.
  }
}

/**
 * This run's state directory: `E2E_STATE_DIR` once `global-setup.ts` has
 * created it (a fresh `fs.mkdtemp` directory per run, see
 * `support/environment.ts`) and exported it, the pointer-file fallback
 * above keyed by this process's parent pid, or (only reachable before
 * `global-setup.ts` has run, see the port fallback comment above) a fixed
 * placeholder that nothing reads or writes.
 */
export function getStateDirectory(): string {
  const fromEnv = process.env.E2E_STATE_DIR;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const fromPointer = readStateDirPointer(process.ppid);
  if (fromPointer !== undefined) {
    return fromPointer;
  }
  return PENDING_STATE_DIR;
}

/** Where the "setup" project's logged-in-as-alice storage state is written. */
export function getAliceStorageStatePath(): string {
  return path.join(getStateDirectory(), "alice-storage-state.json");
}

/**
 * Where `global-setup.ts` records the running environment's ports and
 * process ids, so `global-teardown.ts` can find and stop everything even if
 * it runs in a different process than setup did.
 */
export function getEnvStatePath(): string {
  return path.join(getStateDirectory(), "environment-state.json");
}

/**
 * `auth.setup.ts` needs a plain value rather than a function. This is safe
 * to freeze once per process rather than exporting only the getter above:
 * it is a "setup"-project test, always dispatched to a freshly forked
 * worker process (see the fallback-port comment near the top of this file),
 * which reimports this whole module fresh, after `global-setup.ts` has
 * already resolved and exported the real state directory.
 */
export const ALICE_STORAGE_STATE_PATH = getAliceStorageStatePath();
