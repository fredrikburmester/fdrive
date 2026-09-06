/**
 * Process entrypoint. Excluded from the coverage gate (see
 * `vitest.config.ts`): it only wires already-tested pieces together and
 * talks to the real process, filesystem, and network, which is exercised by
 * running the server rather than by unit tests.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readVersion(dirName: string): string {
  const pkgPath = join(dirName, "..", "package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

const config = loadConfig(process.env);

const logger = pino({
  level: config.logLevel,
  ...(config.nodeEnv === "development" ? { transport: { target: "pino-pretty" } } : {}),
});

const startedAt = new Date();
const version = readVersion(dirname(fileURLToPath(import.meta.url)));

const app = createApp({ config, logger, version, startedAt });
const server = startServer(app, config, logger);

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");

  const timeout = setTimeout(() => {
    logger.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timeout.unref();

  server
    .close()
    .then(() => {
      clearTimeout(timeout);
      process.exit(0);
    })
    .catch((error: unknown) => {
      clearTimeout(timeout);
      logger.error({ error }, "error during shutdown");
      process.exit(1);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
