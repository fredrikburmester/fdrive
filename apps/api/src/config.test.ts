import { describe, expect, it } from "vitest";
import { isBase64Of32Bytes, isHttpUrl, loadConfig, withDefault } from "./config";

const MASTER_KEY_32_BYTES = Buffer.alloc(32, 7).toString("base64");

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  SFTPGO_URL: "http://localhost:8080",
  FDRIVE_MASTER_KEY: MASTER_KEY_32_BYTES,
};

describe("withDefault", () => {
  it("returns the fallback for undefined", () => {
    expect(withDefault(undefined, "fallback")).toBe("fallback");
  });

  it("returns the fallback for an empty string", () => {
    expect(withDefault("", "fallback")).toBe("fallback");
  });

  it("returns the value when it is a non-empty string", () => {
    expect(withDefault("value", "fallback")).toBe("value");
  });
});

describe("isHttpUrl", () => {
  it("accepts an http URL", () => {
    expect(isHttpUrl("http://example.com")).toBe(true);
  });

  it("accepts an https URL", () => {
    expect(isHttpUrl("https://example.com:8080/path")).toBe(true);
  });

  it("rejects a non-http protocol", () => {
    expect(isHttpUrl("ftp://example.com")).toBe(false);
  });

  it("rejects a string that is not a URL at all", () => {
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

describe("isBase64Of32Bytes", () => {
  it("accepts valid base64 that decodes to 32 bytes", () => {
    expect(isBase64Of32Bytes(MASTER_KEY_32_BYTES)).toBe(true);
  });

  it("rejects a string containing invalid base64 characters", () => {
    expect(isBase64Of32Bytes("not-valid-base64!!")).toBe(false);
  });

  it("rejects valid base64 of the wrong length", () => {
    expect(isBase64Of32Bytes(Buffer.alloc(16, 1).toString("base64"))).toBe(false);
  });
});

describe("loadConfig", () => {
  it("applies defaults when only the required variables are set", () => {
    const config = loadConfig(REQUIRED_ENV);

    expect(config).toEqual({
      port: 3001,
      host: "0.0.0.0",
      logLevel: "info",
      databaseUrl: "postgres://localhost/fdrive",
      sftpgoUrl: "http://localhost:8080",
      fdriveMasterKey: MASTER_KEY_32_BYTES,
      fdriveHomeTemplate: "sftpgo:/{username}",
      fdriveSessionTtlDays: 30,
      fdriveCookieSecure: "auto",
      fdrivePublicUrl: undefined,
      nodeEnv: "development",
      fdriveAutoMigrate: true,
    });
  });

  it("throws when a required variable is missing", () => {
    expect(() => loadConfig({})).toThrowError(
      /DATABASE_URL.*\n.*SFTPGO_URL.*\n.*FDRIVE_MASTER_KEY/s,
    );
  });

  it("parses every variable when all are set validly", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      PORT: "8080",
      HOST: "127.0.0.1",
      LOG_LEVEL: "debug",
      FDRIVE_HOME_TEMPLATE: "sftpgo:/home/{username}",
      FDRIVE_SESSION_TTL_DAYS: "7",
      FDRIVE_COOKIE_SECURE: "true",
      FDRIVE_PUBLIC_URL: "https://fdrive.example.com",
      NODE_ENV: "production",
      FDRIVE_AUTO_MIGRATE: "false",
    });

    expect(config).toEqual({
      port: 8080,
      host: "127.0.0.1",
      logLevel: "debug",
      databaseUrl: "postgres://localhost/fdrive",
      sftpgoUrl: "http://localhost:8080",
      fdriveMasterKey: MASTER_KEY_32_BYTES,
      fdriveHomeTemplate: "sftpgo:/home/{username}",
      fdriveSessionTtlDays: 7,
      fdriveCookieSecure: "true",
      fdrivePublicUrl: "https://fdrive.example.com",
      nodeEnv: "production",
      fdriveAutoMigrate: false,
    });
  });

  it("defaults FDRIVE_AUTO_MIGRATE to true and accepts an explicit false", () => {
    expect(loadConfig(REQUIRED_ENV).fdriveAutoMigrate).toBe(true);
    expect(loadConfig({ ...REQUIRED_ENV, FDRIVE_AUTO_MIGRATE: "true" }).fdriveAutoMigrate).toBe(
      true,
    );
    expect(loadConfig({ ...REQUIRED_ENV, FDRIVE_AUTO_MIGRATE: "false" }).fdriveAutoMigrate).toBe(
      false,
    );
  });

  it("rejects an invalid FDRIVE_AUTO_MIGRATE value", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_AUTO_MIGRATE: "yes" })).toThrow(
      /FDRIVE_AUTO_MIGRATE/,
    );
  });

  it("throws listing every invalid variable at once", () => {
    expect(() =>
      loadConfig({
        ...REQUIRED_ENV,
        PORT: "not-a-number",
        LOG_LEVEL: "verbose",
        SFTPGO_URL: "not a url",
        FDRIVE_MASTER_KEY: "short",
        NODE_ENV: "staging",
      }),
    ).toThrowError(/PORT.*\n.*LOG_LEVEL.*\n.*SFTPGO_URL.*\n.*FDRIVE_MASTER_KEY.*\n.*NODE_ENV/s);
  });

  it("rejects a port outside the valid range", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, PORT: "70000" })).toThrow();
  });

  it("rejects an invalid FDRIVE_COOKIE_SECURE value", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_COOKIE_SECURE: "maybe" })).toThrow(
      /FDRIVE_COOKIE_SECURE/,
    );
  });

  it("rejects a non-http FDRIVE_PUBLIC_URL", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_PUBLIC_URL: "not a url" })).toThrow(
      /FDRIVE_PUBLIC_URL/,
    );
  });

  it("rejects a non-integer FDRIVE_SESSION_TTL_DAYS", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_SESSION_TTL_DAYS: "soon" })).toThrow(
      /FDRIVE_SESSION_TTL_DAYS/,
    );
  });

  it("labels a root-level validation issue as (root)", () => {
    expect(() => loadConfig(null as unknown as Record<string, string | undefined>)).toThrow(
      /\(root\)/,
    );
  });

  it("falls back to the default host when HOST is an empty string", () => {
    expect(loadConfig({ ...REQUIRED_ENV, HOST: "" }).host).toBe("0.0.0.0");
  });
});
