import { describe, expect, it } from "vitest";
import { HealthResponse, HealthSubsystemName, HealthSubsystemStatus } from "./health";

const CONFIGURED_SUBSYSTEMS = {
  core: { status: "configured", missing: [] },
  index: { status: "configured", missing: [] },
  search: { status: "not_configured", missing: ["FDRIVE_EMBED_URL"] },
  imageSearch: { status: "not_configured", missing: ["FDRIVE_IMAGE_EMBED_URL"] },
  ocr: { status: "unreachable", missing: [] },
  thumbnails: { status: "configured", missing: [] },
  office: { status: "not_configured", missing: ["FDRIVE_OFFICE_PRODUCT"] },
  trash: { status: "configured", missing: [] },
  shares: { status: "configured", missing: [] },
  network: { status: "configured", missing: [] },
};

describe("HealthResponse", () => {
  it("parses a valid payload", () => {
    const payload = {
      status: "ok",
      service: "fdrive-api",
      version: "0.1.0",
      uptimeSeconds: 12.5,
      subsystems: CONFIGURED_SUBSYSTEMS,
    };

    expect(HealthResponse.parse(payload)).toEqual(payload);
  });

  it("accepts an uptime of exactly zero", () => {
    const payload = {
      status: "ok",
      service: "fdrive-api",
      version: "0.1.0",
      uptimeSeconds: 0,
      subsystems: CONFIGURED_SUBSYSTEMS,
    };

    expect(HealthResponse.parse(payload)).toEqual(payload);
  });

  it("rejects a negative uptime", () => {
    const payload = {
      status: "ok",
      service: "fdrive-api",
      version: "0.1.0",
      uptimeSeconds: -1,
      subsystems: CONFIGURED_SUBSYSTEMS,
    };

    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a status other than ok", () => {
    const payload = {
      status: "degraded",
      service: "fdrive-api",
      version: "0.1.0",
      uptimeSeconds: 0,
      subsystems: CONFIGURED_SUBSYSTEMS,
    };

    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a service name other than fdrive-api", () => {
    const payload = {
      status: "ok",
      service: "other-service",
      version: "0.1.0",
      uptimeSeconds: 0,
      subsystems: CONFIGURED_SUBSYSTEMS,
    };

    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a missing version", () => {
    const payload = {
      status: "ok",
      service: "fdrive-api",
      uptimeSeconds: 0,
      subsystems: CONFIGURED_SUBSYSTEMS,
    };

    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a payload missing subsystems", () => {
    const payload = {
      status: "ok",
      service: "fdrive-api",
      version: "0.1.0",
      uptimeSeconds: 0,
    };

    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects an unknown subsystem name", () => {
    const payload = {
      status: "ok",
      service: "fdrive-api",
      version: "0.1.0",
      uptimeSeconds: 0,
      subsystems: { ...CONFIGURED_SUBSYSTEMS, bogus: { status: "configured", missing: [] } },
    };

    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a subsystem missing a required key", () => {
    const { core, ...rest } = CONFIGURED_SUBSYSTEMS;
    const payload = {
      status: "ok",
      service: "fdrive-api",
      version: "0.1.0",
      uptimeSeconds: 0,
      subsystems: rest,
    };

    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });
});

describe("HealthSubsystemName", () => {
  it("accepts every documented subsystem name", () => {
    for (const name of [
      "core",
      "index",
      "search",
      "imageSearch",
      "ocr",
      "thumbnails",
      "office",
      "trash",
      "shares",
      "network",
    ]) {
      expect(HealthSubsystemName.safeParse(name).success).toBe(true);
    }
  });

  it("rejects an unknown name", () => {
    expect(HealthSubsystemName.safeParse("unknown").success).toBe(false);
  });
});

describe("HealthSubsystemStatus", () => {
  it("accepts each documented status", () => {
    for (const status of ["configured", "not_configured", "unreachable"]) {
      expect(HealthSubsystemStatus.safeParse({ status, missing: [] }).success).toBe(true);
    }
  });

  it("rejects an unknown status", () => {
    expect(HealthSubsystemStatus.safeParse({ status: "degraded", missing: [] }).success).toBe(
      false,
    );
  });

  it("rejects a non-array missing field", () => {
    expect(HealthSubsystemStatus.safeParse({ status: "configured", missing: "x" }).success).toBe(
      false,
    );
  });
});
