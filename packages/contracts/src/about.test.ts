import { describe, expect, it } from "vitest";
import { AboutResponse } from "./about";

describe("AboutResponse", () => {
  const valid = {
    version: "development",
    uptimeSeconds: 90.5,
    providers: [{ type: "local", label: "Local folder" }],
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

  it("parses a valid payload", () => {
    expect(AboutResponse.parse(valid)).toEqual(valid);
  });

  it("parses a payload with no providers and setupRequired true", () => {
    const payload = { ...valid, providers: [], setupRequired: true };
    expect(AboutResponse.parse(payload)).toEqual(payload);
  });

  it("parses a payload where setup is complete but the caller is anonymous (null label)", () => {
    const payload = { ...valid, providers: [{ type: "local" as const, label: null }] };
    expect(AboutResponse.parse(payload)).toEqual(payload);
  });

  it("rejects a missing version", () => {
    const { version: _drop, ...rest } = valid;
    expect(AboutResponse.safeParse(rest).success).toBe(false);
  });

  it("rejects an unknown provider type", () => {
    const payload = { ...valid, providers: [{ type: "other", label: null }] };
    expect(AboutResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a missing providers field", () => {
    const { providers: _drop, ...rest } = valid;
    expect(AboutResponse.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing setupRequired", () => {
    const { setupRequired: _drop, ...rest } = valid;
    expect(AboutResponse.safeParse(rest).success).toBe(false);
  });
});
