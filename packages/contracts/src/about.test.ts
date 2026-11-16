import { describe, expect, it } from "vitest";
import { AboutResponse } from "./about";

describe("AboutResponse", () => {
  const valid = {
    version: "development",
    uptimeSeconds: 90.5,
    setupRequired: false,
  };

  it("requires a non-negative API uptime", () => {
    const { uptimeSeconds: _drop, ...rest } = valid;
    expect(AboutResponse.safeParse(rest).success).toBe(false);
    expect(AboutResponse.safeParse({ ...valid, uptimeSeconds: -1 }).success).toBe(false);
  });

  it("carries the release and revision when the build has them", () => {
    const build = { release: "0.1.0", revision: "0123456789abcdef0123456789abcdef01234567" };
    expect(AboutResponse.parse({ ...valid, ...build })).toEqual({ ...valid, ...build });
    expect(AboutResponse.parse(valid)).not.toHaveProperty("release");
    expect(AboutResponse.parse(valid)).not.toHaveProperty("revision");
  });

  it("parses a valid payload, with setup still required or not", () => {
    expect(AboutResponse.parse(valid)).toEqual(valid);
    expect(AboutResponse.parse({ ...valid, setupRequired: true }).setupRequired).toBe(true);
  });

  it("names no storage", () => {
    expect(AboutResponse.parse({ ...valid, providers: [] })).not.toHaveProperty("providers");
  });

  it("rejects a missing version", () => {
    const { version: _drop, ...rest } = valid;
    expect(AboutResponse.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing setupRequired", () => {
    const { setupRequired: _drop, ...rest } = valid;
    expect(AboutResponse.safeParse(rest).success).toBe(false);
  });
});
