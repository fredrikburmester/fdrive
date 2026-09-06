import { describe, expect, it } from "vitest";
import { revealHref } from "./reveal";

describe("revealHref", () => {
  it("builds the parent folder's href with a select query parameter", () => {
    expect(revealHref("/docs/reports/q1.pdf")).toBe("/files/docs/reports?select=q1.pdf");
  });

  it("handles a top-level file", () => {
    expect(revealHref("/report.pdf")).toBe("/files?select=report.pdf");
  });

  it("url-encodes a name with special characters", () => {
    expect(revealHref("/docs/a b & c.txt")).toBe("/files/docs?select=a%20b%20%26%20c.txt");
  });
});
