import { describe, expect, it } from "vitest";
import { AboutResponse } from "./about";

describe("AboutResponse", () => {
  const valid = {
    version: "1.0.0",
    builtOn: { name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" },
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
});
