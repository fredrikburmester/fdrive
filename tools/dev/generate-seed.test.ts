import { describe, expect, it } from "vitest";
import {
  buildDevSampleFiles,
  buildGradientPngMarker,
  buildSamplePdfMarker,
  buildSamplePngMarker,
} from "./generate-seed.js";

const BASE64_PREFIX = "BASE64:";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decodeMarker(marker: string): Buffer {
  expect(marker.startsWith(BASE64_PREFIX)).toBe(true);
  return Buffer.from(marker.slice(BASE64_PREFIX.length), "base64");
}

describe("buildGradientPngMarker", () => {
  it("encodes a 640x400 PNG", () => {
    const png = decodeMarker(buildGradientPngMarker());
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    // IHDR chunk: 4-byte length, "IHDR", then width and height as big-endian uint32s.
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(640);
    expect(height).toBe(400);
  });

  it("is deterministic", () => {
    expect(buildGradientPngMarker()).toBe(buildGradientPngMarker());
  });
});

describe("buildSamplePdfMarker", () => {
  it("encodes a valid-looking one-page PDF", () => {
    const pdf = decodeMarker(buildSamplePdfMarker());
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text.endsWith("%%EOF")).toBe(true);
  });

  it("stays small, well under a kilobyte", () => {
    const pdf = decodeMarker(buildSamplePdfMarker());
    expect(pdf.length).toBeLessThan(1024);
  });
});

describe("buildDevSampleFiles", () => {
  const files = buildDevSampleFiles();

  it("keeps the original README, photo, and budget files", () => {
    expect(files["/README.md"]).toContain("Welcome to fdrive");
    expect(files["/photo.png"]).toBe(buildSamplePngMarker());
    expect(files["/budget.csv"]).toContain("category,amount");
  });

  it("adds a larger gradient photo", () => {
    expect(files["/gradient.png"]).toBe(buildGradientPngMarker());
  });

  it("adds a notes folder with two markdown files", () => {
    expect(files["/notes/todo.md"]).toContain("# Todo");
    expect(files["/notes/ideas.md"]).toContain("# Ideas");
  });

  it("adds a code folder with one TypeScript file", () => {
    expect(files["/code/example.ts"]).toContain("export function greet");
  });

  it("adds a sample PDF under docs/", () => {
    expect(files["/docs/sample.pdf"]).toBe(buildSamplePdfMarker());
  });
});
