import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("defaults to no --only, not quick, not strict", () => {
    expect(parseArgs([])).toEqual({ only: undefined, quick: false, strict: true });
  });

  it("parses --quick", () => {
    expect(parseArgs(["--quick"]).quick).toBe(true);
  });

  it("parses --strict", () => {
    expect(parseArgs(["--strict"]).strict).toBe(true);
  });

  it("parses --only with a known scenario name", () => {
    expect(parseArgs(["--only", "list1k"]).only).toBe("list1k");
  });

  it("diagnostics cannot claim strict success", () => {
    expect(parseArgs(["--diagnostic"]).strict).toBe(false);
    for (const flags of [
      ["--strict", "--quick"],
      ["--strict", "--only", "downloadDirect"],
      ["--strict", "--diagnostic"],
    ])
      expect(() => parseArgs(flags)).toThrow(/requires all/);
  });

  it("throws when --only is missing its value", () => {
    expect(() => parseArgs(["--only"])).toThrow("--only requires a scenario name");
  });

  it("throws when --only names an unknown scenario", () => {
    expect(() => parseArgs(["--only", "nonsense"])).toThrow(/not a known scenario/);
  });

  it("throws on an unrecognized flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow("unknown argument: --bogus");
  });
});
