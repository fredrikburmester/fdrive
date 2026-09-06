import { describe, expect, it } from "vitest";
import { AboutResponse } from "./about";

describe("AboutResponse", () => {
  const valid = {
    version: "1.0.0",
    builtOn: { name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" },
    provider: { type: "sftpgo", label: "localhost:8080" },
  };

  it("parses a valid payload", () => {
    expect(AboutResponse.parse(valid)).toEqual(valid);
  });

  it("rejects a builtOn.name other than SFTPGo", () => {
    const payload = { ...valid, builtOn: { ...valid.builtOn, name: "Other" } };
    expect(AboutResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a non-url sourceUrl", () => {
    const payload = { ...valid, builtOn: { ...valid.builtOn, sourceUrl: "not-a-url" } };
    expect(AboutResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a missing version", () => {
    const { version: _drop, ...rest } = valid;
    expect(AboutResponse.safeParse(rest).success).toBe(false);
  });

  it("rejects a provider.type other than sftpgo", () => {
    const payload = { ...valid, provider: { ...valid.provider, type: "other" } };
    expect(AboutResponse.safeParse(payload).success).toBe(false);
  });

  it("rejects a missing provider", () => {
    const { provider: _drop, ...rest } = valid;
    expect(AboutResponse.safeParse(rest).success).toBe(false);
  });
});
