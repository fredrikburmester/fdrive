import { createServer } from "node:net";

/**
 * Binds an ephemeral TCP port on `host` (port `0`, the kernel's "pick one for
 * me" convention), reads back whatever the OS assigned, and closes the
 * socket immediately so the real server that actually needs the port can
 * bind it next. There is an unavoidable, tiny race between the close here
 * and the real bind in `support/environment.ts` (another process could grab
 * the same port in between), but in practice this is only ever run once at
 * the very start of `global-setup.ts`, well before anything else on the
 * machine is likely contending for it.
 */
export function getFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("fdrive e2e: could not read back an ephemeral port"));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
        } else {
          resolve(port);
        }
      });
    });
  });
}

function parsePort(envVar: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`fdrive e2e: ${envVar}="${raw}" is not a valid port number`);
  }
  return parsed;
}

/**
 * Resolves the port a e2e server should use: `process.env[envVar]` when set
 * (so `E2E_API_PORT=3931 pnpm test:e2e` pins it, letting two suites run
 * side by side without colliding), otherwise a freshly bound ephemeral port
 * on `host`. Called once per port from `global-setup.ts`, which then writes
 * the resolved value back onto `process.env[envVar]` so every other reader
 * in this run (this same process, and any worker forked from it) sees the
 * same number instead of each picking its own.
 */
export async function resolvePort(envVar: string, host: string): Promise<number> {
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined && fromEnv !== "") {
    return parsePort(envVar, fromEnv);
  }
  return await getFreePort(host);
}
