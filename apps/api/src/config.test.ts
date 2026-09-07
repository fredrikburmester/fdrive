import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_MAX_BYTES,
  isBase64Of32Bytes,
  isHttpUrl,
  loadConfig,
  parseAdminUsers,
  parseIndexRoots,
  parseTrashPath,
  undefinedWhenEmpty,
  withDefault,
} from "./config";

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

describe("undefinedWhenEmpty", () => {
  it("returns undefined for undefined", () => {
    expect(undefinedWhenEmpty(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(undefinedWhenEmpty("")).toBeUndefined();
  });

  it("returns the value when it is a non-empty string", () => {
    expect(undefinedWhenEmpty("value")).toBe("value");
  });
});

describe("parseIndexRoots", () => {
  it("returns null for undefined", () => {
    expect(parseIndexRoots(undefined)).toBeNull();
  });

  it("parses a valid single-root JSON array", () => {
    const raw = JSON.stringify([
      { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
    ]);
    expect(parseIndexRoots(raw)).toEqual([
      { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
    ]);
  });

  it("parses multiple roots", () => {
    const raw = JSON.stringify([
      { name: "sftpgo", sftpgoPath: "/a", indexerPath: "/roots/a" },
      { name: "photos", sftpgoPath: "/b", indexerPath: "/roots/b" },
    ]);
    expect(parseIndexRoots(raw)).toHaveLength(2);
  });

  it("throws for invalid JSON", () => {
    expect(() => parseIndexRoots("not json")).toThrow(/valid JSON/);
  });

  it("throws for an empty array", () => {
    expect(() => parseIndexRoots("[]")).toThrow();
  });

  it("throws when a root is missing a required field", () => {
    expect(() => parseIndexRoots(JSON.stringify([{ name: "sftpgo" }]))).toThrow();
  });

  it("throws when the value is not an array", () => {
    expect(() => parseIndexRoots(JSON.stringify({ name: "sftpgo" }))).toThrow();
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
      fdriveOfficeProduct: undefined,
      fdriveOfficeUrl: undefined,
      fdriveOfficePublicUrl: undefined,
      fdriveWopiUrl: undefined,
      fdriveOfficeMaxBytes: 104857600,
      fdriveOfficeEditRules: [],
      port: 3001,
      host: "0.0.0.0",
      logLevel: "info",
      databaseUrl: "postgres://localhost/fdrive",
      sftpgoUrl: "http://localhost:8080",
      fdriveMasterKey: MASTER_KEY_32_BYTES,
      fdriveHomeTemplate: "sftpgo:/{username}",
      fdriveSessionTtlDays: 30,
      fdriveCookieSecure: "auto",
      fdriveTrustedProxyHops: 1,
      fdrivePublicUrl: undefined,
      nodeEnv: "development",
      fdriveAutoMigrate: true,
      fdriveTmpDir: tmpdir(),
      fdriveJobMaxBytes: DEFAULT_JOB_MAX_BYTES,
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
    });
  });

  it("throws when a required variable is missing", () => {
    expect(() => loadConfig({})).toThrowError(/DATABASE_URL.*\n.*FDRIVE_MASTER_KEY/s);
  });

  it("leaves sftpgoUrl undefined when SFTPGO_URL is not set", () => {
    const { SFTPGO_URL: _drop, ...rest } = REQUIRED_ENV;
    expect(loadConfig(rest).sftpgoUrl).toBeUndefined();
  });

  it("leaves sftpgoUrl undefined when SFTPGO_URL is an empty string", () => {
    expect(loadConfig({ ...REQUIRED_ENV, SFTPGO_URL: "" }).sftpgoUrl).toBeUndefined();
  });

  it("rejects a non-empty, non-http(s) SFTPGO_URL", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, SFTPGO_URL: "not a url" })).toThrow(/SFTPGO_URL/);
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
      FDRIVE_TRUSTED_PROXY_HOPS: "2",
      FDRIVE_PUBLIC_URL: "https://fdrive.example.com",
      NODE_ENV: "production",
      FDRIVE_AUTO_MIGRATE: "false",
      FDRIVE_TMP_DIR: "/var/tmp/fdrive",
      FDRIVE_JOB_MAX_BYTES: "1000",
      FDRIVE_INDEX_ROOTS: JSON.stringify([
        { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
      ]),
      FDRIVE_EMBED_URL: "http://embed:8081",
      FDRIVE_THUMBS_DIR: "/data/thumbs",
      FDRIVE_ADMIN_USERS: "alice, bob",
      FDRIVE_SETUP_TOKEN: "fixed-token",
      FDRIVE_INDEXER_URL: "http://indexer:8010",
      FDRIVE_OCR_URL: "http://ocr:8020",
      FDRIVE_MCP_WRITES: "true",
      FDRIVE_SFTPGO_TRASH_PATH: "/.trash",
      FDRIVE_SFTPGO_TRASH_RETENTION_HOURS: "72",
    });

    expect(config).toEqual({
      fdriveOfficeProduct: undefined,
      fdriveOfficeUrl: undefined,
      fdriveOfficePublicUrl: undefined,
      fdriveWopiUrl: undefined,
      fdriveOfficeMaxBytes: 104857600,
      fdriveOfficeEditRules: [],
      port: 8080,
      host: "127.0.0.1",
      logLevel: "debug",
      databaseUrl: "postgres://localhost/fdrive",
      sftpgoUrl: "http://localhost:8080",
      fdriveMasterKey: MASTER_KEY_32_BYTES,
      fdriveHomeTemplate: "sftpgo:/home/{username}",
      fdriveSessionTtlDays: 7,
      fdriveCookieSecure: "true",
      fdriveTrustedProxyHops: 2,
      fdrivePublicUrl: "https://fdrive.example.com",
      nodeEnv: "production",
      fdriveAutoMigrate: false,
      fdriveTmpDir: "/var/tmp/fdrive",
      fdriveJobMaxBytes: 1000,
      fdriveIndexRoots: [
        { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
      ],
      fdriveEmbedUrl: "http://embed:8081",
      fdriveThumbsDir: "/data/thumbs",
      fdriveAdminUsers: ["alice", "bob"],
      fdriveSetupToken: "fixed-token",
      fdriveIndexerUrl: "http://indexer:8010",
      fdriveOcrUrl: "http://ocr:8020",
      fdriveMcpWrites: true,
      fdriveSftpgoTrashPath: "/.trash",
      fdriveSftpgoTrashRetentionHours: 72,
    });
  });

  it("defaults FDRIVE_INDEX_ROOTS, FDRIVE_EMBED_URL, and FDRIVE_THUMBS_DIR to unset", () => {
    const config = loadConfig(REQUIRED_ENV);
    expect(config.fdriveIndexRoots).toBeNull();
    expect(config.fdriveEmbedUrl).toBeUndefined();
    expect(config.fdriveThumbsDir).toBeUndefined();
  });

  it("defaults FDRIVE_INDEXER_URL and FDRIVE_OCR_URL to unset, and FDRIVE_MCP_WRITES to false", () => {
    const config = loadConfig(REQUIRED_ENV);
    expect(config.fdriveIndexerUrl).toBeUndefined();
    expect(config.fdriveOcrUrl).toBeUndefined();
    expect(config.fdriveMcpWrites).toBe(false);
  });

  it("rejects a non-http FDRIVE_INDEXER_URL", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_INDEXER_URL: "not a url" })).toThrow(
      /FDRIVE_INDEXER_URL/,
    );
  });

  it("rejects a non-http FDRIVE_OCR_URL", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_OCR_URL: "not a url" })).toThrow(
      /FDRIVE_OCR_URL/,
    );
  });

  it("defaults FDRIVE_SFTPGO_TRASH_PATH and FDRIVE_SFTPGO_TRASH_RETENTION_HOURS to null", () => {
    const config = loadConfig(REQUIRED_ENV);
    expect(config.fdriveSftpgoTrashPath).toBeNull();
    expect(config.fdriveSftpgoTrashRetentionHours).toBeNull();
  });

  it("treats an empty FDRIVE_SFTPGO_TRASH_PATH the same as unset", () => {
    const config = loadConfig({ ...REQUIRED_ENV, FDRIVE_SFTPGO_TRASH_PATH: "" });
    expect(config.fdriveSftpgoTrashPath).toBeNull();
  });

  it("rejects an invalid FDRIVE_SFTPGO_TRASH_PATH", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_SFTPGO_TRASH_PATH: "/" })).toThrow(
      /FDRIVE_SFTPGO_TRASH_PATH/,
    );
  });

  it("rejects a non-integer FDRIVE_SFTPGO_TRASH_RETENTION_HOURS", () => {
    expect(() =>
      loadConfig({ ...REQUIRED_ENV, FDRIVE_SFTPGO_TRASH_RETENTION_HOURS: "not a number" }),
    ).toThrow(/FDRIVE_SFTPGO_TRASH_RETENTION_HOURS/);
  });

  it("rejects a zero FDRIVE_SFTPGO_TRASH_RETENTION_HOURS", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_SFTPGO_TRASH_RETENTION_HOURS: "0" })).toThrow(
      /FDRIVE_SFTPGO_TRASH_RETENTION_HOURS/,
    );
  });

  it("treats an empty FDRIVE_INDEXER_URL as unset", () => {
    expect(
      loadConfig({ ...REQUIRED_ENV, FDRIVE_INDEXER_URL: "" }).fdriveIndexerUrl,
    ).toBeUndefined();
  });

  it("parses FDRIVE_MCP_WRITES=true and rejects an invalid value", () => {
    expect(loadConfig({ ...REQUIRED_ENV, FDRIVE_MCP_WRITES: "true" }).fdriveMcpWrites).toBe(true);
    expect(loadConfig({ ...REQUIRED_ENV, FDRIVE_MCP_WRITES: "false" }).fdriveMcpWrites).toBe(false);
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_MCP_WRITES: "yes" })).toThrow(
      /FDRIVE_MCP_WRITES/,
    );
  });

  it("rejects an invalid FDRIVE_INDEX_ROOTS", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_INDEX_ROOTS: "not json" })).toThrow(
      /FDRIVE_INDEX_ROOTS/,
    );
  });

  it("rejects a non-http FDRIVE_EMBED_URL", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_EMBED_URL: "not a url" })).toThrow(
      /FDRIVE_EMBED_URL/,
    );
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

  it("defaults FDRIVE_TRUSTED_PROXY_HOPS to 1", () => {
    expect(loadConfig(REQUIRED_ENV).fdriveTrustedProxyHops).toBe(1);
  });

  it("accepts a custom FDRIVE_TRUSTED_PROXY_HOPS, including 0", () => {
    expect(
      loadConfig({ ...REQUIRED_ENV, FDRIVE_TRUSTED_PROXY_HOPS: "0" }).fdriveTrustedProxyHops,
    ).toBe(0);
    expect(
      loadConfig({ ...REQUIRED_ENV, FDRIVE_TRUSTED_PROXY_HOPS: "3" }).fdriveTrustedProxyHops,
    ).toBe(3);
  });

  it("rejects a non-integer FDRIVE_TRUSTED_PROXY_HOPS", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_TRUSTED_PROXY_HOPS: "many" })).toThrow(
      /FDRIVE_TRUSTED_PROXY_HOPS/,
    );
  });

  it("rejects a negative FDRIVE_TRUSTED_PROXY_HOPS", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_TRUSTED_PROXY_HOPS: "-1" })).toThrow(
      /FDRIVE_TRUSTED_PROXY_HOPS/,
    );
  });

  it("rejects a non-http FDRIVE_PUBLIC_URL", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_PUBLIC_URL: "not a url" })).toThrow(
      /FDRIVE_PUBLIC_URL/,
    );
  });

  it("treats an empty FDRIVE_PUBLIC_URL as unset", () => {
    expect(loadConfig({ ...REQUIRED_ENV, FDRIVE_PUBLIC_URL: "" }).fdrivePublicUrl).toBeUndefined();
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

  it("defaults FDRIVE_TMP_DIR to the OS temp dir", () => {
    expect(loadConfig(REQUIRED_ENV).fdriveTmpDir).toBe(tmpdir());
  });

  it("accepts a custom FDRIVE_TMP_DIR", () => {
    expect(loadConfig({ ...REQUIRED_ENV, FDRIVE_TMP_DIR: "/data/tmp" }).fdriveTmpDir).toBe(
      "/data/tmp",
    );
  });

  it("defaults FDRIVE_JOB_MAX_BYTES to 10 GiB", () => {
    expect(loadConfig(REQUIRED_ENV).fdriveJobMaxBytes).toBe(DEFAULT_JOB_MAX_BYTES);
  });

  it("rejects a non-integer FDRIVE_JOB_MAX_BYTES", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_JOB_MAX_BYTES: "lots" })).toThrow(
      /FDRIVE_JOB_MAX_BYTES/,
    );
  });

  it("rejects a zero FDRIVE_JOB_MAX_BYTES", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_JOB_MAX_BYTES: "0" })).toThrow(
      /FDRIVE_JOB_MAX_BYTES/,
    );
  });

  it("defaults FDRIVE_SETUP_TOKEN to undefined when it is an empty string", () => {
    expect(
      loadConfig({ ...REQUIRED_ENV, FDRIVE_SETUP_TOKEN: "" }).fdriveSetupToken,
    ).toBeUndefined();
  });
});

describe("parseTrashPath", () => {
  it("returns null for undefined", () => {
    expect(parseTrashPath(undefined)).toBeNull();
  });

  it("returns a valid normalized absolute path unchanged", () => {
    expect(parseTrashPath("/.trash")).toBe("/.trash");
  });

  it("rejects the root", () => {
    expect(() => parseTrashPath("/")).toThrow(/root/);
  });

  it("rejects a path with a trailing slash (not already normalized)", () => {
    expect(() => parseTrashPath("/.trash/")).toThrow(/normalized/);
  });

  it('rejects a path containing ".."', () => {
    expect(() => parseTrashPath("/.trash/../etc")).toThrow(/normalized/);
  });

  it("rejects a relative path", () => {
    expect(() => parseTrashPath(".trash")).toThrow(/normalized/);
  });

  it("rejects a path normalizePath itself refuses", () => {
    expect(() => parseTrashPath("/\0bad")).toThrow(/valid path/);
  });
});

describe("parseAdminUsers", () => {
  it("returns an empty array for undefined", () => {
    expect(parseAdminUsers(undefined)).toEqual([]);
  });

  it("returns an empty array for an empty or whitespace-only string", () => {
    expect(parseAdminUsers("")).toEqual([]);
    expect(parseAdminUsers("   ")).toEqual([]);
  });

  it("splits a comma-separated list and trims whitespace", () => {
    expect(parseAdminUsers("alice, bob ,carol")).toEqual(["alice", "bob", "carol"]);
  });

  it("drops empty entries from stray commas", () => {
    expect(parseAdminUsers("alice,,bob,")).toEqual(["alice", "bob"]);
  });

  it("returns a single-element array for one username", () => {
    expect(parseAdminUsers("alice")).toEqual(["alice"]);
  });
});

describe("Office operator edit policy", () => {
  it("defaults to no grants and validates explicit rules at startup", () => {
    expect(loadConfig(REQUIRED_ENV).fdriveOfficeEditRules).toEqual([]);
    expect(
      loadConfig({ ...REQUIRED_ENV, FDRIVE_OFFICE_EDIT_RULES: "" }).fdriveOfficeEditRules,
    ).toEqual([]);
    const rule = {
      providerId: "12345678-1234-4234-8234-123456789abc",
      username: "alice",
      path: "/docs",
      recursive: true,
      allow: true,
    };
    expect(
      loadConfig({ ...REQUIRED_ENV, FDRIVE_OFFICE_EDIT_RULES: JSON.stringify([rule]) })
        .fdriveOfficeEditRules,
    ).toEqual([rule]);
    for (const value of ["bad", "{}", '[{"allow":true}]', " ".repeat(131073)])
      expect(() => loadConfig({ ...REQUIRED_ENV, FDRIVE_OFFICE_EDIT_RULES: value })).toThrow(
        "FDRIVE_OFFICE_EDIT_RULES",
      );
  });
});
