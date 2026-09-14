/**
 * Process entrypoint. Excluded from the coverage gate (see
 * `vitest.config.ts`): it only wires already-tested pieces together and
 * talks to the real process, filesystem, and network, which is exercised by
 * running the server rather than by unit tests.
 */
import pino from "pino";
import { runBackupCommand } from "./backups/command.js";
import { composeApp } from "./composition.js";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

if (process.argv[2] === "backup") {
  try {
    await runBackupCommand(() => loadConfig(process.env), process.argv.slice(3));
    process.exit(0);
  } catch {
    process.stderr.write(
      "Backup command failed. Check arguments, private key/review file, target database and storage. No secret values are logged.\n",
    );
    process.exit(1);
  }
}

const config = loadConfig(process.env);

const logger = pino({
  level: config.logLevel,
  ...(config.nodeEnv === "development" ? { transport: { target: "pino-pretty" } } : {}),
});

const composed = await composeApp(config, logger);
const server = startServer(composed.app, config, logger);

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");

  const timeout = setTimeout(() => {
    logger.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timeout.unref();

  server
    .close()
    .then(() => composed.close())
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
