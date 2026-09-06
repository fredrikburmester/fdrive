import { loadConfig } from "@fdrive/api/config";
import { describe, expect, it } from "vitest";
import { buildStackEnv } from "./stack-env.js";

describe("buildStackEnv", () => {
  it("carries through the database url, sftpgo url, and master key", () => {
    const env = buildStackEnv({
      databaseUrl: "postgres://user:pass@localhost:5432/fdrive",
      sftpgoUrl: "http://localhost:8080",
      masterKeyBase64: Buffer.alloc(32, 1).toString("base64"),
    });
    expect(env.DATABASE_URL).toBe("postgres://user:pass@localhost:5432/fdrive");
    expect(env.SFTPGO_URL).toBe("http://localhost:8080");
    expect(env.FDRIVE_MASTER_KEY).toBe(Buffer.alloc(32, 1).toString("base64"));
  });

  it("sets FDRIVE_COOKIE_SECURE to false and LOG_LEVEL to warn", () => {
    const env = buildStackEnv({
      databaseUrl: "postgres://localhost/fdrive",
      sftpgoUrl: "http://localhost:8080",
      masterKeyBase64: Buffer.alloc(32).toString("base64"),
    });
    expect(env.FDRIVE_COOKIE_SECURE).toBe("false");
    expect(env.LOG_LEVEL).toBe("warn");
  });

  it("produces an env object loadConfig accepts", () => {
    const env = buildStackEnv({
      databaseUrl: "postgres://localhost/fdrive",
      sftpgoUrl: "http://localhost:8080",
      masterKeyBase64: Buffer.alloc(32).toString("base64"),
    });
    const config = loadConfig(env);
    expect(config.databaseUrl).toBe(env.DATABASE_URL);
    expect(config.sftpgoUrl).toBe(env.SFTPGO_URL);
    expect(config.fdriveCookieSecure).toBe("false");
    expect(config.logLevel).toBe("warn");
  });
});
