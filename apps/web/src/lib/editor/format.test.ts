import { describe, expect, it } from "vitest";
import { capitalize } from "./format";

describe("capitalize", () => {
  it("uppercases the first letter", () => {
    expect(capitalize("markdown")).toBe("Markdown");
  });

  it("returns an empty string unchanged", () => {
    expect(capitalize("")).toBe("");
  });

  it("leaves an already-capitalized word unchanged", () => {
    expect(capitalize("Text")).toBe("Text");
  });
});
