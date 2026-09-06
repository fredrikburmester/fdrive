import { describe, expect, it } from "vitest";
import { isBase64Of32Bytes, isHttpUrl, loadConfig, withDefault } from "./config";

const MASTER_KEY_32_BYTES = Buffer.alloc(32, 7).toString("base64");

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
  it("applies defaults when no variables are set", () => {
    const config = loadConfig({});

    expect(config).toEqual({
      port: 3001,
      host: "0.0.0.0",
      logLevel: "info",
      databaseUrl: undefined,
      sftpgoUrl: undefined,
      fdriveMasterKey: undefined,
      fdriveHomeTemplate: "sftpgo:/{username}",
      nodeEnv: "development",
    });
  });

  it("parses every variable when all are set validly", () => {
    const config = loadConfig({
      PORT: "8080",
      HOST: "127.0.0.1",
      LOG_LEVEL: "debug",
      DATABASE_URL: "postgres://localhost/fdrive",
      SFTPGO_URL: "https://sftpgo.internal:9000",
      FDRIVE_MASTER_KEY: MASTER_KEY_32_BYTES,
      FDRIVE_HOME_TEMPLATE: "sftpgo:/home/{username}",
      NODE_ENV: "production",
    });

    expect(config).toEqual({
      port: 8080,
      host: "127.0.0.1",
      logLevel: "debug",
      databaseUrl: "postgres://localhost/fdrive",
      sftpgoUrl: "https://sftpgo.internal:9000",
      fdriveMasterKey: MASTER_KEY_32_BYTES,
      fdriveHomeTemplate: "sftpgo:/home/{username}",
      nodeEnv: "production",
    });
  });

  it("throws listing every invalid variable at once", () => {
    expect(() =>
      loadConfig({
        PORT: "not-a-number",
        LOG_LEVEL: "verbose",
        SFTPGO_URL: "not a url",
        FDRIVE_MASTER_KEY: "short",
        NODE_ENV: "staging",
      }),
    ).toThrowError(/PORT.*\n.*LOG_LEVEL.*\n.*SFTPGO_URL.*\n.*FDRIVE_MASTER_KEY.*\n.*NODE_ENV/s);
  });

  it("rejects a port outside the valid range", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow();
  });

  it("labels a root-level validation issue as (root)", () => {
    expect(() => loadConfig(null as unknown as Record<string, string | undefined>)).toThrow(
      /\(root\)/,
    );
  });

  it("falls back to the default host when HOST is an empty string", () => {
    expect(loadConfig({ HOST: "" }).host).toBe("0.0.0.0");
  });
});
