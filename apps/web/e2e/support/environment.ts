import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPostgres, startSftpgo } from "@fdrive/testkit";
import {
  API_BASE_URL,
  E2E_API_PORT,
  E2E_HOST,
  E2E_WEB_PORT,
  ENV_STATE_PATH,
  STATE_DIRECTORY,
  WEB_BASE_URL,
} from "./paths.js";
import { waitForHttpOk } from "./wait.js";

const supportDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(supportDir, "..", "..");
const apiDir = resolve(webDir, "..", "api");
const repoRoot = resolve(webDir, "..", "..");

const SERVER_READY_TIMEOUT_MS = 90_000;

/** Whether to run the web app via `next dev` instead of a production build, for faster local iteration. */
function isDevServerMode(): boolean {
  return process.env.E2E_DEV === "1";
}

export interface RunningEnvironment {
  /** The seeded Postgres container's connection string, for tests that seed extra rows directly. */
  readonly databaseUrl: string;
  stop(): Promise<void>;
}

export interface StartEnvironmentOptions {
  /**
   * Extra environment variables merged into the spawned API process's env,
   * on top of the fixed set below (e.g. `FDRIVE_INDEX_ROOTS` for the search
   * e2e suite). Empty by default so existing callers are unaffected.
   */
  readonly extraApiEnv?: Record<string, string>;
}

interface EnvironmentState {
  readonly apiPid: number | undefined;
  readonly webPid: number | undefined;
  readonly apiPort: number;
  readonly webPort: number;
}

async function persistState(state: EnvironmentState): Promise<void> {
  await mkdir(STATE_DIRECTORY, { recursive: true });
  await writeFile(ENV_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/** Buffers a child process's stdout/stderr so it can be dumped if startup fails. */
function captureOutput(child: ChildProcess, label: string): { dump(): string } {
  const chunks: string[] = [];
  child.stdout?.on("data", (data: Buffer) => chunks.push(`[${label}:stdout] ${data.toString()}`));
  child.stderr?.on("data", (data: Buffer) => chunks.push(`[${label}:stderr] ${data.toString()}`));
  return { dump: () => chunks.join("") };
}

function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    child.once("exit", () => resolvePromise());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  });
}

/**
 * Boots the whole e2e stack: a seeded Postgres and SFTPGo (via
 * `@fdrive/testkit`), the fdrive API as a child `tsx` process (imported
 * with the `development` condition so it runs straight from source, no
 * build step required), and the web app either as a production build +
 * `next start` (the default, matching how it actually ships) or `next dev`
 * when `E2E_DEV=1` (faster to iterate on locally).
 *
 * Returns a `stop()` that tears everything down in reverse order. On any
 * failure during startup, already-started pieces are stopped before the
 * error is rethrown, so a failed `globalSetup` never leaks a container or
 * process.
 */
export async function startEnvironment(
  options: StartEnvironmentOptions = {},
): Promise<RunningEnvironment> {
  const stopFns: Array<() => Promise<void>> = [];

  async function stopAll(): Promise<void> {
    for (const fn of stopFns.reverse()) {
      await fn().catch((error: unknown) => {
        console.error("fdrive e2e: error while stopping the environment", error);
      });
    }
    stopFns.length = 0;
  }

  try {
    const postgres = await startPostgres();
    stopFns.push(() => postgres.stop());

    const sftpgo = await startSftpgo();
    stopFns.push(() => sftpgo.stop());

    const masterKey = randomBytes(32).toString("base64");

    const apiChild = spawn(
      join(apiDir, "node_modules", ".bin", "tsx"),
      ["--conditions=development", "src/main.ts"],
      {
        cwd: apiDir,
        env: {
          ...process.env,
          PORT: String(E2E_API_PORT),
          HOST: E2E_HOST,
          LOG_LEVEL: "warn",
          NODE_ENV: "test",
          DATABASE_URL: postgres.connectionString,
          SFTPGO_URL: sftpgo.baseUrl,
          FDRIVE_MASTER_KEY: masterKey,
          FDRIVE_COOKIE_SECURE: "false",
          FDRIVE_AUTO_MIGRATE: "true",
          ...options.extraApiEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const apiOutput = captureOutput(apiChild, "api");
    stopFns.push(() => killProcess(apiChild));

    try {
      await waitForHttpOk(`${API_BASE_URL}/api/v1/health`, SERVER_READY_TIMEOUT_MS);
    } catch (error) {
      throw new Error(
        `fdrive e2e: API never became healthy.\n${apiOutput.dump()}\n${String(error)}`,
      );
    }

    const nodeEnv: "development" | "production" = isDevServerMode() ? "development" : "production";
    const webEnv = {
      ...process.env,
      API_INTERNAL_URL: API_BASE_URL,
      PORT: String(E2E_WEB_PORT),
      HOSTNAME: E2E_HOST,
      NODE_ENV: nodeEnv,
    };

    let webChild: ChildProcess;
    if (isDevServerMode()) {
      webChild = spawn(
        join(webDir, "node_modules", ".bin", "next"),
        ["dev", "-p", String(E2E_WEB_PORT), "-H", E2E_HOST],
        {
          cwd: webDir,
          env: webEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } else {
      // `next build` runs in the "production" export condition, which
      // `@fdrive/core` and `@fdrive/contracts` only satisfy via their
      // built `dist/index.js` (their `exports` map has no "production"
      // key, so it falls through to "default"). Build through pnpm's
      // dependency-ordered filter (`@fdrive/web...`, "the package and
      // everything it depends on") rather than calling `next build`
      // directly, so those workspace packages are compiled first.
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const build = spawn("pnpm", ["--filter", "@fdrive/web...", "run", "build"], {
          cwd: repoRoot,
          env: webEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const buildOutput = captureOutput(build, "web:build");
        build.once("exit", (code) => {
          if (code === 0) {
            resolvePromise();
          } else {
            rejectPromise(
              new Error(`fdrive e2e: web build failed (exit ${code}).\n${buildOutput.dump()}`),
            );
          }
        });
        build.once("error", rejectPromise);
      });

      webChild = spawn(
        join(webDir, "node_modules", ".bin", "next"),
        ["start", "-p", String(E2E_WEB_PORT), "-H", E2E_HOST],
        {
          cwd: webDir,
          env: webEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    }
    const webOutput = captureOutput(webChild, "web");
    stopFns.push(() => killProcess(webChild));

    try {
      await waitForHttpOk(`${WEB_BASE_URL}/login`, SERVER_READY_TIMEOUT_MS);
    } catch (error) {
      throw new Error(
        `fdrive e2e: web app never became ready.\n${webOutput.dump()}\n${String(error)}`,
      );
    }

    await persistState({
      apiPid: apiChild.pid,
      webPid: webChild.pid,
      apiPort: E2E_API_PORT,
      webPort: E2E_WEB_PORT,
    });

    return { databaseUrl: postgres.connectionString, stop: stopAll };
  } catch (error) {
    await stopAll();
    throw error;
  }
}
