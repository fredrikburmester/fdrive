import { describe, expect, it } from "vitest";
import { splitNameForSelection } from "./naming";

describe("splitNameForSelection", () => {
  it("splits a simple file name", () => {
    expect(splitNameForSelection("report.pdf")).toEqual({ base: "report", ext: ".pdf" });
  });

  it("uses the last dot for a multi-dot name", () => {
    expect(splitNameForSelection("archive.tar.gz")).toEqual({ base: "archive.tar", ext: ".gz" });
  });

  it("treats a dotfile as having no extension", () => {
    expect(splitNameForSelection(".env")).toEqual({ base: ".env", ext: "" });
  });

  it("treats a name with no dot as having no extension", () => {
    expect(splitNameForSelection("README")).toEqual({ base: "README", ext: "" });
  });

  it("treats a trailing dot as having no extension", () => {
    expect(splitNameForSelection("weird.")).toEqual({ base: "weird.", ext: "" });
  });
});
