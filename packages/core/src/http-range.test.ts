import { describe, expect, it } from "vitest";
import { contentDisposition, parseRangeHeader } from "./http-range.js";

describe("parseRangeHeader", () => {
  it("returns kind none when there is no header", () => {
    expect(parseRangeHeader(null, 100)).toEqual({ kind: "none" });
    expect(parseRangeHeader(null, null)).toEqual({ kind: "none" });
  });

  it("parses a bounded range bytes=a-b", () => {
    expect(parseRangeHeader("bytes=0-10", 100)).toEqual({ kind: "single", start: 0, end: 10 });
    expect(parseRangeHeader("bytes=0-10", null)).toEqual({ kind: "single", start: 0, end: 10 });
  });

  it("clamps the end of a bounded range to size - 1", () => {
    expect(parseRangeHeader("bytes=0-999", 100)).toEqual({ kind: "single", start: 0, end: 99 });
  });

  it("parses an open-ended range bytes=a-", () => {
    expect(parseRangeHeader("bytes=50-", 100)).toEqual({ kind: "single", start: 50 });
    expect(parseRangeHeader("bytes=50-", null)).toEqual({ kind: "single", start: 50 });
  });

  it("converts a suffix range bytes=-n to a start when size is known", () => {
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({ kind: "single", start: 90, end: 99 });
  });

  it("clamps a suffix range longer than the resource to the whole resource", () => {
    expect(parseRangeHeader("bytes=-1000", 100)).toEqual({ kind: "single", start: 0, end: 99 });
  });

  it("rejects a suffix range when size is unknown", () => {
    expect(parseRangeHeader("bytes=-10", null)).toEqual({ kind: "invalid" });
  });

  it("rejects a suffix range of zero or negative length", () => {
    expect(parseRangeHeader("bytes=-0", 100)).toEqual({ kind: "invalid" });
  });

  it("rejects a multi-range header", () => {
    expect(parseRangeHeader("bytes=0-10,20-30", 100)).toEqual({ kind: "invalid" });
  });

  it("rejects a header with neither a start nor an end", () => {
    expect(parseRangeHeader("bytes=-", 100)).toEqual({ kind: "invalid" });
  });

  it("rejects a header that is not bytes=", () => {
    expect(parseRangeHeader("items=0-10", 100)).toEqual({ kind: "invalid" });
  });

  it("rejects a malformed header", () => {
    expect(parseRangeHeader("not a range", 100)).toEqual({ kind: "invalid" });
  });

  it("rejects a start at or beyond a known size", () => {
    expect(parseRangeHeader("bytes=100-", 100)).toEqual({ kind: "invalid" });
    expect(parseRangeHeader("bytes=150-200", 100)).toEqual({ kind: "invalid" });
  });

  it("rejects an end before the start", () => {
    expect(parseRangeHeader("bytes=10-5", 100)).toEqual({ kind: "invalid" });
  });

  it("accepts a start-only range with unknown size and no upper validation", () => {
    expect(parseRangeHeader("bytes=1000-", null)).toEqual({ kind: "single", start: 1000 });
  });
});

describe("contentDisposition", () => {
  it("builds an inline header for a plain ASCII filename", () => {
    expect(contentDisposition("inline", "photo.png")).toBe(
      "inline; filename=\"photo.png\"; filename*=UTF-8''photo.png",
    );
  });

  it("builds an attachment header for a plain ASCII filename", () => {
    expect(contentDisposition("attachment", "report.pdf")).toBe(
      "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
    );
  });

  it("falls back to underscores for non-ASCII characters and encodes the extended value", () => {
    const result = contentDisposition("attachment", "café.txt");
    expect(result).toContain('filename="caf_.txt"');
    expect(result).toContain("filename*=UTF-8''caf%C3%A9.txt");
  });

  it("escapes quotes and backslashes in the ASCII fallback", () => {
    const result = contentDisposition("attachment", '"weird\\name".txt');
    expect(result).toContain('filename="_weird_name_.txt"');
  });

  it("falls back to download when the filename is empty", () => {
    const result = contentDisposition("attachment", "");
    expect(result).toContain('filename="download"');
  });

  it("replaces every character of an all non-ASCII filename with underscores", () => {
    const result = contentDisposition("attachment", "文書");
    expect(result).toContain('filename="__"');
  });

  it("percent-encodes RFC 5987 reserved characters left alone by encodeURIComponent", () => {
    const result = contentDisposition("attachment", "it's (final)*.txt");
    expect(result).toContain("filename*=UTF-8''it%27s%20%28final%29%2A.txt");
  });
});
