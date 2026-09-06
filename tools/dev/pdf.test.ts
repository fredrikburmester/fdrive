import { describe, expect, it } from "vitest";
import { encodeMinimalPdf, escapePdfText } from "./pdf.js";

describe("escapePdfText", () => {
  it("leaves plain ASCII text untouched", () => {
    expect(escapePdfText("Hello, fdrive")).toBe("Hello, fdrive");
  });

  it("escapes backslashes and parentheses, backslash first", () => {
    expect(escapePdfText("a(b)c\\d")).toBe("a\\(b\\)c\\\\d");
  });
});

describe("encodeMinimalPdf", () => {
  const pdf = encodeMinimalPdf("Hello, fdrive sample PDF");
  const text = pdf.toString("latin1");

  it("starts with a PDF header and ends with the EOF marker", () => {
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF")).toBe(true);
  });

  it("is small, a few hundred bytes for a short line of text", () => {
    expect(pdf.length).toBeGreaterThan(200);
    expect(pdf.length).toBeLessThan(1000);
  });

  it("embeds the given text in the content stream", () => {
    expect(text).toContain("(Hello, fdrive sample PDF) Tj");
  });

  it("has a xref table whose offsets point exactly at each object's header", () => {
    const xrefIndex = text.lastIndexOf("\nxref\n");
    expect(xrefIndex).toBeGreaterThan(0);
    const xrefSection = text.slice(xrefIndex + 1);
    const lines = xrefSection.split("\n");
    // lines[0] = "xref", lines[1] = "0 6", lines[2] = the object-0 free entry
    expect(lines[1]).toBe("0 6");

    for (let objectId = 1; objectId <= 5; objectId += 1) {
      const entryLine = lines[2 + objectId];
      expect(entryLine).toBeDefined();
      const offset = Number((entryLine ?? "").slice(0, 10));
      const expectedHeader = `${objectId} 0 obj`;
      expect(text.slice(offset, offset + expectedHeader.length)).toBe(expectedHeader);
    }
  });

  it("declares a trailer whose /Size matches the object count and /Root points at object 1", () => {
    expect(text).toContain("trailer\n<< /Size 6 /Root 1 0 R >>");
  });

  it("declares startxref pointing at the real byte offset of the xref keyword", () => {
    const xrefOffset = text.indexOf("xref\n0 6");
    const startxrefMatch = /startxref\n(\d+)\n/.exec(text);
    expect(startxrefMatch).not.toBeNull();
    expect(Number(startxrefMatch?.[1])).toBe(xrefOffset);
  });

  it("is deterministic for the same input", () => {
    expect(encodeMinimalPdf("Hello, fdrive sample PDF").equals(pdf)).toBe(true);
  });
});
