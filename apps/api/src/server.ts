import { serve } from "@hono/node-server";
import type { Logger } from "pino";
import type { AppHono } from "./app.js";
import type { AppConfig } from "./config.js";

export interface StartedServer {
  close(): Promise<void>;
}

/**
 * Starts the Node HTTP server for `app` on the host/port from `config`.
 * Returns a handle whose `close()` resolves once the server has stopped
 * accepting connections and finished in-flight ones.
 */
export function startServer(app: AppHono, config: AppConfig, logger: Logger): StartedServer {
  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: config.host,
    },
    (info) => {
      logger.info({ host: config.host, port: info.port }, "server listening");
    },
  );

  return {
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
