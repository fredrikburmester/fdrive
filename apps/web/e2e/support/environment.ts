import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPostgres, startSftpgo } from "@fdrive/testkit";
import {
  E2E_HOST,
  getApiBaseUrl,
  getApiPort,
  getEnvStatePath,
  getStateDirectory,
  getWebBaseUrl,
  getWebPort,
} from "./paths.js";
import { waitForHttpOk } from "./wait.js";

const supportDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(supportDir, "..", "..");
const apiDir = resolve(webDir, "..", "api");
const appsDir = resolve(webDir, "..");
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
   * e2e suite, `FDRIVE_INDEXER_URL` for the fake indexer `system.spec.ts`
   * uses). Empty by default so existing callers are unaffected.
   */
  readonly extraApiEnv?: Record<string, string>;
  /**
   * Extra teardown steps run alongside Postgres, SFTPGo, and the API/web
   * processes, in the same best-effort, keep-going-on-error fashion (see
   * `stopAll` below). Used by `global-setup.ts` to stop the fake indexer
   * server it starts to back `extraApiEnv.FDRIVE_INDEXER_URL`, so that
   * server's lifecycle rides along with the rest of this environment's
   * `stop()` rather than needing its own teardown wiring.
   */
  readonly extraStopFns?: ReadonlyArray<() => Promise<void>>;
}

interface EnvironmentState {
  readonly apiPid: number | undefined;
  readonly webPid: number | undefined;
  readonly apiPort: number;
  readonly webPort: number;
}

async function persistState(state: EnvironmentState): Promise<void> {
  await mkdir(getStateDirectory(), { recursive: true });
  await writeFile(getEnvStatePath(), JSON.stringify(state, null, 2), "utf-8");
}

/**
 * The top-level entries of `apps/web` that a production build actually
 * needs (source, config, and dependencies), symlinked one by one into a
 * per-run "shadow" directory so `next build` never shares a `.next` output
 * directory across two runs. This matters because `next.config.ts` reads
 * `API_INTERNAL_URL` at build time (to bake the `/api/*` rewrite
 * destination into `.next/routes-manifest.json`); two runs with different
 * API ports sharing one `.next` would silently make both serve whichever
 * run built last. `node_modules` is included wholesale rather than
 * reconstructed, so workspace packages and the `next` binary resolve
 * exactly as they do in `apps/web` itself.
 */
const BUILD_SHADOW_ENTRIES = [
  "src",
  "public",
  "package.json",
  "next.config.ts",
  "tsconfig.json",
  "postcss.config.mjs",
  "components.json",
  "biome.json",
  "node_modules",
];

/**
 * Creates (replacing any stale leftovers from a previous run with the same
 * ports) a shadow build directory as a *sibling* of `apps/web`, i.e. under
 * `apps/`, not nested inside it: `next.config.ts`'s `tsconfig.json` extends
 * `../../tsconfig.base.json` relative to its own (symlinked) location, so
 * the shadow directory has to sit at the exact same depth from the repo
 * root as `apps/web` for that relative path to still resolve. A directory
 * nested one level *inside* `apps/web` breaks it (`extends` would need an
 * extra `../`); a directory entirely outside the repo breaks Turbopack in a
 * different way (it treats symlinks pointing outside its own project root
 * as invalid).
 */
async function createBuildShadow(apiPort: number, webPort: number): Promise<string> {
  const shadowDir = join(appsDir, `web-e2e-shadow-${apiPort}-${webPort}`);
  await rm(shadowDir, { recursive: true, force: true });
  await mkdir(shadowDir, { recursive: true });
  for (const entry of BUILD_SHADOW_ENTRIES) {
    await symlink(join(webDir, entry), join(shadowDir, entry));
  }
  return shadowDir;
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
  const stopFns: Array<() => Promise<void>> = [...(options.extraStopFns ?? [])];

  async function stopAll(): Promise<void> {
    for (const fn of stopFns.reverse()) {
      await fn().catch((error: unknown) => {
        console.error("fdrive e2e: error while stopping the environment", error);
      });
    }
    stopFns.length = 0;
  }

  try {
    const apiPort = getApiPort();
    const webPort = getWebPort();
    const apiBaseUrl = getApiBaseUrl();
    const webBaseUrl = getWebBaseUrl();

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
          PORT: String(apiPort),
          HOST: E2E_HOST,
          LOG_LEVEL: "warn",
          NODE_ENV: "test",
          DATABASE_URL: postgres.connectionString,
          SFTPGO_URL: sftpgo.baseUrl,
          FDRIVE_MASTER_KEY: masterKey,
          FDRIVE_COOKIE_SECURE: "false",
          FDRIVE_AUTO_MIGRATE: "true",
          // alice is the e2e suite's always-admin user (system.spec.ts),
          // so the System sidebar section and its admin-only routes have
          // someone to exercise them without a `/setup` run in every spec.
          FDRIVE_ADMIN_USERS: "alice",
          // Makes `System > Thumbnails` render as configured (see
          // `system.spec.ts`): no spec relies on real thumbnail files
          // existing under it, so the OS temp directory is enough. Never
          // written to; the indexer that would populate it is the fake one
          // started in `global-setup.ts`, which serves fixed JSON and never
          // touches disk.
          FDRIVE_THUMBS_DIR: tmpdir(),
          ...options.extraApiEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const apiOutput = captureOutput(apiChild, "api");
    stopFns.push(() => killProcess(apiChild));

    try {
      await waitForHttpOk(`${apiBaseUrl}/api/v1/health`, SERVER_READY_TIMEOUT_MS);
    } catch (error) {
      throw new Error(
        `fdrive e2e: API never became healthy.\n${apiOutput.dump()}\n${String(error)}`,
      );
    }

    const nodeEnv: "development" | "production" = isDevServerMode() ? "development" : "production";
    const webEnv = {
      ...process.env,
      API_INTERNAL_URL: apiBaseUrl,
      PORT: String(webPort),
      HOSTNAME: E2E_HOST,
      NODE_ENV: nodeEnv,
    };

    let webChild: ChildProcess;
    if (isDevServerMode()) {
      webChild = spawn(
        join(webDir, "node_modules", ".bin", "next"),
        ["dev", "-p", String(webPort), "-H", E2E_HOST],
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
      // key, so it falls through to "default"). Build the workspace
      // dependencies (everything `@fdrive/web` depends on, `^...`,
      // *excluding* `@fdrive/web` itself) through pnpm's dependency-ordered
      // filter first; the web app itself is then built directly (see
      // `createBuildShadow` above) in its own per-run shadow directory, so
      // its `.next` output never collides with a concurrently running
      // suite's build.
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const build = spawn("pnpm", ["--filter", "@fdrive/web^...", "run", "build"], {
          cwd: repoRoot,
          env: webEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const buildOutput = captureOutput(build, "deps:build");
        build.once("exit", (code) => {
          if (code === 0) {
            resolvePromise();
          } else {
            rejectPromise(
              new Error(
                `fdrive e2e: workspace deps build failed (exit ${code}).\n${buildOutput.dump()}`,
              ),
            );
          }
        });
        build.once("error", rejectPromise);
      });

      const buildShadowDir = await createBuildShadow(apiPort, webPort);
      stopFns.push(() => rm(buildShadowDir, { recursive: true, force: true }));

      await new Promise<void>((resolvePromise, rejectPromise) => {
        const build = spawn(join(webDir, "node_modules", ".bin", "next"), ["build"], {
          cwd: buildShadowDir,
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
        ["start", "-p", String(webPort), "-H", E2E_HOST],
        {
          cwd: buildShadowDir,
          env: webEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    }
    const webOutput = captureOutput(webChild, "web");
    stopFns.push(() => killProcess(webChild));

    try {
      await waitForHttpOk(`${webBaseUrl}/login`, SERVER_READY_TIMEOUT_MS);
    } catch (error) {
      throw new Error(
        `fdrive e2e: web app never became ready.\n${webOutput.dump()}\n${String(error)}`,
      );
    }

    await persistState({
      apiPid: apiChild.pid,
      webPid: webChild.pid,
      apiPort,
      webPort,
    });

    return { databaseUrl: postgres.connectionString, stop: stopAll };
  } catch (error) {
    await stopAll();
    throw error;
  }
}
