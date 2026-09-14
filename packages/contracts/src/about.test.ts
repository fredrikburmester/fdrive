import { describe, expect, it } from "vitest";
import { AboutResponse } from "./about";

describe("AboutResponse", () => {
  const valid = {
    version: "1.0.0",
    builtOn: [{ name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" }],
    providers: [{ type: "sftpgo", label: "localhost:8080" }],
    setupRequired: false,
  };

  it("accepts API uptime while remaining compatible with older servers", () => {
    expect(AboutResponse.parse({ ...valid, uptimeSeconds: 90.5 }).uptimeSeconds).toBe(90.5);
    expect(AboutResponse.parse(valid).uptimeSeconds).toBeUndefined();
    expect(AboutResponse.safeParse({ ...valid, uptimeSeconds: -1 }).success).toBe(false);
  });

  it("parses a valid payload", () => {
    expect(AboutResponse.parse(valid)).toEqual(valid);
  });

  it("parses a payload with no providers and setupRequired true", () => {
    const payload = { ...valid, builtOn: [], providers: [], setupRequired: true };
    expect(AboutResponse.parse(payload)).toEqual(payload);
  });

  it("parses a payload where setup is complete but the caller is anonymous (null label)", () => {
    const payload = { ...valid, providers: [{ type: "sftpgo" as const, label: null }] };
    expect(AboutResponse.parse(payload)).toEqual(payload);
  });

  it("rejects a non-url sourceUrl", () => {
    const payload = { ...valid, builtOn: [{ name: "SFTPGo", sourceUrl: "not-a-url" }] };
    expect(AboutResponse.safeParse(payload).success).toBe(false);
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
