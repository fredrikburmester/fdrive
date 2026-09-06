import { describe, expect, it } from "vitest";
import { defaultFileName } from "./new-file";

describe("defaultFileName", () => {
  it("suggests Untitled.txt for a plain text file", () => {
    expect(defaultFileName("text")).toBe("Untitled.txt");
  });

  it("suggests Untitled.md for a markdown file", () => {
    expect(defaultFileName("markdown")).toBe("Untitled.md");
  });
});
