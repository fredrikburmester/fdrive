import { describe, expect, it } from "vitest";
import {
  isoFromNs,
  normalizeExtArg,
  nsFromIso,
  overviewFolderKey,
  pageText,
  pathDepth,
} from "./format.js";

describe("nsFromIso", () => {
  it("converts an ISO date to nanoseconds", () => {
    expect(nsFromIso("2026-01-01T00:00:00.000Z")).toBe(
      BigInt(new Date("2026-01-01T00:00:00.000Z").getTime()) * 1_000_000n,
    );
  });

  it("returns undefined for undefined", () => {
    expect(nsFromIso(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(nsFromIso("   ")).toBeUndefined();
  });

  it("returns undefined for an unparsable date", () => {
    expect(nsFromIso("not a date")).toBeUndefined();
  });
});

describe("isoFromNs", () => {
  it("round-trips through nsFromIso", () => {
    const iso = "2026-01-01T00:00:00.000Z";
    const ns = nsFromIso(iso);
    if (ns === undefined) {
      throw new Error("expected ns");
    }
    expect(isoFromNs(ns)).toBe(iso);
  });
});

describe("normalizeExtArg", () => {
  it("lowercases and adds a leading dot", () => {
    expect(normalizeExtArg("PDF")).toBe(".pdf");
  });

  it("leaves an existing leading dot alone", () => {
    expect(normalizeExtArg(".PDF")).toBe(".pdf");
  });

  it("returns undefined for undefined", () => {
    expect(normalizeExtArg(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(normalizeExtArg("  ")).toBeUndefined();
  });
});

describe("overviewFolderKey", () => {
  it("groups a shallow file under its first-level folder", () => {
    expect(overviewFolderKey(0, 1, "/docs/report.pdf")).toBe("/docs");
  });

  it("groups a file with no folder at all under root", () => {
    expect(overviewFolderKey(0, 1, "/report.pdf")).toBe("/");
  });

  it("groups a deeper file to the cut depth", () => {
    expect(overviewFolderKey(0, 1, "/docs/2026/report.pdf")).toBe("/docs");
  });

  it("respects a non-zero prefix depth", () => {
    expect(overviewFolderKey(1, 1, "/docs/2026/report.pdf")).toBe("/docs/2026");
  });

  it("handles the root path", () => {
    expect(overviewFolderKey(0, 1, "/")).toBe("/");
  });

  it("supports depth greater than 1", () => {
    expect(overviewFolderKey(0, 2, "/docs/2026/q1/report.pdf")).toBe("/docs/2026");
  });
});

describe("pathDepth", () => {
  it("is 0 for the root", () => {
    expect(pathDepth("/")).toBe(0);
  });

  it("counts segments", () => {
    expect(pathDepth("/docs/2026")).toBe(2);
  });
});

describe("pageText", () => {
  it("slices from the offset up to maxChars (clamped to at least 200)", () => {
    const text = "0123456789".repeat(30); // 300 chars
    const result = pageText(text, 2, 250);
    expect(result.slice).toBe(text.slice(2, 252));
    expect(result.totalChars).toBe(300);
    expect(result.hasMore).toBe(true);
  });

  it("reports hasMore false when the slice reaches the end", () => {
    const result = pageText("0123456789", 5, 100);
    expect(result.slice).toBe("56789");
    expect(result.hasMore).toBe(false);
  });

  it("clamps maxChars to at least 200", () => {
    const text = "a".repeat(300);
    const result = pageText(text, 0, 10);
    expect(result.slice).toHaveLength(200);
  });

  it("clamps maxChars to at most 40000", () => {
    const text = "a".repeat(50_000);
    const result = pageText(text, 0, 1_000_000);
    expect(result.slice).toHaveLength(40_000);
  });

  it("clamps a negative offset to 0", () => {
    const result = pageText("0123456789", -5, 200);
    expect(result.slice).toBe("0123456789");
  });
});
