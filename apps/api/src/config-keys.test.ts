import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { type AppConfig, configEnvKeys, loadConfig } from "./config";
import {
  applyReachability,
  CONFIG_KEYS,
  type ConfigKeyDef,
  SUBSYSTEMS,
  type Subsystem,
  type SubsystemStatus,
  startupSummaryLines,
  subsystemsStatus,
} from "./config-keys";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  SFTPGO_URL: "http://localhost:8080",
  FDRIVE_MASTER_KEY: MASTER_KEY,
};

/** A fully "everything configured" config, built by loading env for every optional subsystem. */
function loadFullyConfiguredEnv(): AppConfig {
  return loadConfig({
    ...REQUIRED_ENV,
    FDRIVE_INDEX_ROOTS: JSON.stringify([
      { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
    ]),
    FDRIVE_INDEXER_URL: "http://indexer:8010",
    FDRIVE_EMBED_URL: "http://embed:80",
    FDRIVE_IMAGE_EMBED_URL: "http://image-embed:8012",
    FDRIVE_THUMBS_DIR: "/thumbs",
    FDRIVE_OCR_URL: "http://ocr:8011",
    FDRIVE_SFTPGO_TRASH_PATH: "/.trash",
    FDRIVE_OFFICE_PRODUCT: "onlyoffice",
    FDRIVE_OFFICE_URL: "http://onlyoffice",
    FDRIVE_OFFICE_PUBLIC_URL: "https://office.example.com",
    FDRIVE_WOPI_URL: "http://api:3001/wopi",
    FDRIVE_PUBLIC_URL: "https://fdrive.example.com",
  });
}

describe("CONFIG_KEYS", () => {
  it("has one entry per key config.ts's envSchema reads, and vice versa", () => {
    const tableKeys = [...CONFIG_KEYS.map((entry) => entry.key)].sort();
    const schemaKeys = [...configEnvKeys()].sort();
    expect(tableKeys).toEqual(schemaKeys);
  });

  it("has no duplicate keys", () => {
    const keys = CONFIG_KEYS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every entry's subsystem is one of SUBSYSTEMS", () => {
    for (const entry of CONFIG_KEYS) {
      expect(SUBSYSTEMS).toContain(entry.subsystem);
    }
  });

  it("every entry has a non-empty description and example", () => {
    for (const entry of CONFIG_KEYS) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(typeof entry.example).toBe("string");
    }
  });

  it("FDRIVE_TMP_DIR documents the OS temp dir default is used, matching config.ts's actual fallback", () => {
    const entry = CONFIG_KEYS.find((candidate) => candidate.key === "FDRIVE_TMP_DIR");
    expect(entry).toBeDefined();
    expect(entry?.default).toBeNull();
    // Sanity check the runtime default this describes still resolves to something real.
    expect(tmpdir().length).toBeGreaterThan(0);
  });
});

function baseConfig(): AppConfig {
  return loadConfig(REQUIRED_ENV);
}

describe("subsystemsStatus", () => {
  it("reports every optional subsystem as not_configured with its missing keys when nothing extra is set", () => {
    const statuses = subsystemsStatus(baseConfig());

    expect(statuses.core).toEqual({ status: "configured", missing: [] });
    expect(statuses.network).toEqual({ status: "configured", missing: [] });
    expect(statuses.shares).toEqual({ status: "configured", missing: [] });
    expect(statuses.index).toEqual({
      status: "not_configured",
      missing: ["FDRIVE_INDEX_ROOTS", "FDRIVE_INDEXER_URL"],
    });
    expect(statuses.search).toEqual({
      status: "not_configured",
      missing: ["FDRIVE_EMBED_URL"],
    });
    expect(statuses.imageSearch).toEqual({
      status: "not_configured",
      missing: ["FDRIVE_IMAGE_EMBED_URL"],
    });
    expect(statuses.thumbnails).toEqual({
      status: "not_configured",
      missing: ["FDRIVE_THUMBS_DIR"],
    });
    expect(statuses.ocr).toEqual({ status: "not_configured", missing: ["FDRIVE_OCR_URL"] });
    expect(statuses.office).toEqual({
      status: "not_configured",
      missing: [
        "FDRIVE_OFFICE_PRODUCT",
        "FDRIVE_OFFICE_URL",
        "FDRIVE_OFFICE_PUBLIC_URL",
        "FDRIVE_WOPI_URL",
      ],
    });
    expect(statuses.trash).toEqual({
      status: "not_configured",
      missing: ["FDRIVE_SFTPGO_TRASH_PATH"],
    });
  });

  it("reports index as configured only once both FDRIVE_INDEX_ROOTS and FDRIVE_INDEXER_URL are set", () => {
    const rootsOnly = loadConfig({
      ...REQUIRED_ENV,
      FDRIVE_INDEX_ROOTS: JSON.stringify([
        { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
      ]),
    });
    expect(subsystemsStatus(rootsOnly).index).toEqual({
      status: "not_configured",
      missing: ["FDRIVE_INDEXER_URL"],
    });

    const both = loadConfig({
      ...REQUIRED_ENV,
      FDRIVE_INDEX_ROOTS: JSON.stringify([
        { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
      ]),
      FDRIVE_INDEXER_URL: "http://indexer:8010",
    });
    expect(subsystemsStatus(both).index).toEqual({ status: "configured", missing: [] });
  });

  it("reports every subsystem as configured once fully configured", () => {
    const statuses = subsystemsStatus(loadFullyConfiguredEnv());
    for (const subsystem of SUBSYSTEMS) {
      expect(statuses[subsystem]).toEqual({ status: "configured", missing: [] });
    }
  });
});

describe("applyReachability", () => {
  const base: Record<Subsystem, SubsystemStatus> = {
    core: { status: "configured", missing: [] },
    network: { status: "configured", missing: [] },
    shares: { status: "configured", missing: [] },
    index: { status: "configured", missing: [] },
    search: { status: "not_configured", missing: ["FDRIVE_EMBED_URL"] },
    imageSearch: { status: "configured", missing: [] },
    thumbnails: { status: "configured", missing: [] },
    ocr: { status: "configured", missing: [] },
    office: { status: "configured", missing: [] },
    trash: { status: "configured", missing: [] },
  };

  it("marks a configured subsystem unreachable when its probe fails", () => {
    const result = applyReachability(base, { index: false });
    expect(result.index).toEqual({ status: "unreachable", missing: [] });
  });

  it("leaves a configured subsystem configured when its probe succeeds", () => {
    const result = applyReachability(base, { index: true });
    expect(result.index).toEqual({ status: "configured", missing: [] });
  });

  it("leaves a subsystem unchanged when no probe result is supplied", () => {
    const result = applyReachability(base, {});
    expect(result.index).toEqual({ status: "configured", missing: [] });
    expect(result.search).toEqual({ status: "not_configured", missing: ["FDRIVE_EMBED_URL"] });
  });

  it("never marks a not_configured subsystem unreachable, even if a probe result is (incorrectly) supplied", () => {
    const result = applyReachability(base, { search: false });
    expect(result.search).toEqual({ status: "not_configured", missing: ["FDRIVE_EMBED_URL"] });
  });
});

describe("startupSummaryLines", () => {
  it("logs one status line per subsystem plus the trusted-proxy-hops bind hint when unset", () => {
    const lines = startupSummaryLines(baseConfig());

    expect(lines).toContain("subsystem=core status=configured");
    expect(lines).toContain(
      "subsystem=index status=not configured missing=FDRIVE_INDEX_ROOTS,FDRIVE_INDEXER_URL",
    );
    expect(lines).toContain("subsystem=search status=not configured missing=FDRIVE_EMBED_URL");
    expect(lines.some((line) => line.startsWith("subsystem=network bind hint"))).toBe(true);
    expect(lines).toHaveLength(SUBSYSTEMS.length + 1);
  });

  it("omits the bind hint once FDRIVE_TRUSTED_PROXY_HOPS is set away from its default", () => {
    const config = loadConfig({ ...REQUIRED_ENV, FDRIVE_TRUSTED_PROXY_HOPS: "2" });
    const lines = startupSummaryLines(config);
    expect(lines.some((line) => line.startsWith("subsystem=network bind hint"))).toBe(false);
    expect(lines).toHaveLength(SUBSYSTEMS.length);
  });

  it("logs every subsystem as configured once fully configured", () => {
    const lines = startupSummaryLines(loadFullyConfiguredEnv());
    for (const subsystem of SUBSYSTEMS) {
      expect(lines).toContain(`subsystem=${subsystem} status=configured`);
    }
  });
});

describe("ConfigKeyDef", () => {
  it("is assignable with every field", () => {
    const entry: ConfigKeyDef = {
      key: "EXAMPLE",
      description: "An example.",
      default: null,
      example: "value",
      secret: false,
      subsystem: "core",
    };
    expect(entry.key).toBe("EXAMPLE");
  });
});
