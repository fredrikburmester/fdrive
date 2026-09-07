import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { AppConfig } from "./config";
import { startServer } from "./server";

function createTestLogger(): Logger {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return logger as unknown as Logger;
}

function buildConfig(): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    logLevel: "silent",
    databaseUrl: "postgres://localhost/fdrive",
    sftpgoUrl: "http://localhost:8080",
    fdriveMasterKey: Buffer.alloc(32, 7).toString("base64"),
    fdriveHomeTemplate: "sftpgo:/{username}",
    fdriveSessionTtlDays: 30,
    fdriveCookieSecure: "auto",
    fdriveTrustedProxyHops: 1,
    fdrivePublicUrl: undefined,
    nodeEnv: "test",
    fdriveAutoMigrate: true,
    fdriveTmpDir: "/tmp",
    fdriveJobMaxBytes: 1_000_000_000,
    fdriveIndexRoots: null,
    fdriveEmbedUrl: undefined,
    fdriveThumbsDir: undefined,
    fdriveAdminUsers: [],
    fdriveSetupToken: undefined,
    fdriveIndexerUrl: undefined,
    fdriveOcrUrl: undefined,
    fdriveMcpWrites: false,
    fdriveSftpgoTrashPath: null,
    fdriveSftpgoTrashRetentionHours: null,
  };
}

describe("startServer", () => {
  it("serves the app on an ephemeral port and logs on listen", async () => {
    const logger = createTestLogger();
    const config = buildConfig();
    const app = createApp({ config, logger, version: "1.0.0", startedAt: new Date() });

    const server = startServer(app, config, logger);

    try {
      await vi.waitFor(() => {
        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({ host: "127.0.0.1", port: expect.any(Number) }),
          "server listening",
        );
      });
    } finally {
      await server.close();
    }
  });

  it("rejects a second close() once the server is already stopped", async () => {
    const logger = createTestLogger();
    const config = buildConfig();
    const app = createApp({ config, logger, version: "1.0.0", startedAt: new Date() });

    const server = startServer(app, config, logger);

    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ host: "127.0.0.1" }),
        "server listening",
      );
    });

    await server.close();

    await expect(server.close()).rejects.toThrow();
  });
});
