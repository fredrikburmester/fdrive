import { describe, expect, it } from "vitest";
import { HealthResponse } from "./health";

describe("HealthResponse", () => {
  it("parses a valid payload", () => {
    const payload = {
      status: "ok",
      service: "fdrive-api",
      version: "0.1.0",
      uptimeSeconds: 12.5,
    };

    expect(HealthResponse.parse(payload)).toEqual(payload);
  });

  it("accepts an uptime of exactly zero", () => {
    const payload = {
      status: "ok",
      service: "fdrive-api",
      version: "0.1.0",
      uptimeSeconds: 0,
    };

    expect(HealthResponse.parse(payload)).toEqual(payload);
  });

  it("rejects a negative uptime", () => {
    const payload = {
      status: "ok",
      service: "fdrive-api",
      version: "0.1.0",
      uptimeSeconds: -1,
    };

    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a status other than ok", () => {
    const payload = {
      status: "degraded",
      service: "fdrive-api",
      version: "0.1.0",
      uptimeSeconds: 0,
    };

    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a service name other than fdrive-api", () => {
    const payload = {
      status: "ok",
      service: "other-service",
      version: "0.1.0",
      uptimeSeconds: 0,
    };

    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a missing version", () => {
    const payload = {
      status: "ok",
      service: "fdrive-api",
      uptimeSeconds: 0,
    };

    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });
});
