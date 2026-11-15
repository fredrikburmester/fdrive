import { describe, expect, it } from "vitest";
import { contentDisposition, fileSlice, ifRangeMatches, parseRangeHeader } from "./http-range.ts";

describe("parseRangeHeader", () => {
  it("returns kind none when there is no header", () => {
    expect(parseRangeHeader(null, 100)).toEqual({ kind: "none" });
  });

  it("parses a bounded range bytes=a-b", () => {
    expect(parseRangeHeader("bytes=0-10", 100)).toEqual({ kind: "single", start: 0, end: 10 });
  });

  it("clamps the end of a bounded range to size - 1", () => {
    expect(parseRangeHeader("bytes=0-999", 100)).toEqual({ kind: "single", start: 0, end: 99 });
  });

  it("ends an open-ended range bytes=a- at the last byte", () => {
    expect(parseRangeHeader("bytes=50-", 100)).toEqual({ kind: "single", start: 50, end: 99 });
  });

  it("converts a suffix range bytes=-n to the last n bytes", () => {
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({ kind: "single", start: 90, end: 99 });
  });

  it("clamps a suffix range longer than the resource to the whole resource", () => {
    expect(parseRangeHeader("bytes=-1000", 100)).toEqual({ kind: "single", start: 0, end: 99 });
  });

  it("rejects a suffix range for an empty resource", () => {
    expect(parseRangeHeader("bytes=-10", 0)).toEqual({ kind: "invalid" });
  });

  it("rejects a suffix range of zero length", () => {
    expect(parseRangeHeader("bytes=-0", 100)).toEqual({ kind: "invalid" });
  });

  it("identifies a valid multi-range header for whole-response fallback", () => {
    expect(parseRangeHeader("bytes=0-10, 20-30", 100)).toEqual({ kind: "multiple" });
    expect(parseRangeHeader("bytes=7-7, -3, 20-", 100)).toEqual({ kind: "multiple" });
  });

  it("rejects a malformed multi-range header", () => {
    expect(parseRangeHeader("bytes=10-5,20-30", 100)).toEqual({ kind: "invalid" });
    expect(parseRangeHeader("bytes=9-8,20-30", 100)).toEqual({ kind: "invalid" });
    expect(parseRangeHeader("bytes=0-10,nope", 100)).toEqual({ kind: "invalid" });
    expect(parseRangeHeader("bytes=-,0-10", 100)).toEqual({ kind: "invalid" });
    expect(parseRangeHeader("items=0-10,20-30", 100)).toEqual({ kind: "invalid" });
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

  it("rejects a start at or beyond the size", () => {
    expect(parseRangeHeader("bytes=100-", 100)).toEqual({ kind: "invalid" });
    expect(parseRangeHeader("bytes=150-200", 100)).toEqual({ kind: "invalid" });
    expect(parseRangeHeader("bytes=0-", 0)).toEqual({ kind: "invalid" });
  });

  it("rejects an end before the start", () => {
    expect(parseRangeHeader("bytes=10-5", 100)).toEqual({ kind: "invalid" });
  });
});

describe("ifRangeMatches", () => {
  const modifiedAt = new Date("2026-11-15T10:00:00.750Z");

  it("applies without If-Range, and for a date naming the file's second", () => {
    expect(ifRangeMatches(null, modifiedAt)).toBe(true);
    expect(ifRangeMatches(modifiedAt.toUTCString(), modifiedAt)).toBe(true);
  });

  it("never matches an entity tag, another second or a value that is no date", () => {
    for (const value of ['"etag"', 'W/"etag"', "Sun, 15 Nov 2026 09:59:59 GMT", "garbage"]) {
      expect(ifRangeMatches(value, modifiedAt), value).toBe(false);
    }
  });
});

describe("fileSlice", () => {
  const file = { size: 10, modifiedAt: new Date("2026-11-15T10:00:00Z") };

  it("sends the whole file without a range", () => {
    expect(fileSlice(file, null, null)).toEqual({ status: 200, start: 0, end: 9 });
    expect(fileSlice({ ...file, size: 0 }, null, null)).toEqual({ status: 200, start: 0, end: -1 });
  });

  it("sends one range, and 416 for a range the file cannot satisfy", () => {
    expect(fileSlice(file, "bytes=-4", null)).toEqual({ status: 206, start: 6, end: 9 });
    expect(fileSlice(file, "bytes=20-", null)).toEqual({ status: 416 });
    expect(fileSlice({ ...file, size: 0 }, "bytes=0-", null)).toEqual({ status: 416 });
  });

  it("sends the whole file for several ranges, or once If-Range no longer names it", () => {
    expect(fileSlice(file, "bytes=0-1,4-5", null)).toEqual({ status: 200, start: 0, end: 9 });
    expect(fileSlice(file, "bytes=0-4", '"etag"')).toEqual({ status: 200, start: 0, end: 9 });
    expect(fileSlice(file, "bytes=20-", '"etag"')).toEqual({ status: 200, start: 0, end: 9 });
    expect(fileSlice(file, "bytes=0-4", file.modifiedAt.toUTCString())).toEqual({
      status: 206,
      start: 0,
      end: 4,
    });
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
