import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("defaults to no --only, not quick, not strict", () => {
    expect(parseArgs([])).toEqual({ only: undefined, quick: false, strict: false });
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

  it("combines flags in any order", () => {
    const options = parseArgs(["--strict", "--only", "downloadDirect", "--quick"]);
    expect(options).toEqual({ only: "downloadDirect", quick: true, strict: true });
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
