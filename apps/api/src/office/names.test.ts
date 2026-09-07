import { describe, expect, it } from "vitest";
import { decodeUtf7, lockHeader, requireFilename, stemOf, suggestedFilename } from "./names.ts";

describe("WOPI UTF-7 and filenames", () => {
  it.each([
    ["hello", "hello"],
    ["+-", "+"],
    ["+AMU-rsrapport", "Årsrapport"],
    ["+2D3egA-", "🚀"],
    ["+AOUA5AD2-", "åäö"],
  ])("decodes %s", (raw, result) => expect(decodeUtf7(raw)).toBe(result));
  it.each([
    "å",
    "+",
    "+AA",
    "+AA=-",
    "+A!-",
    "+A-",
    "+AA-",
    "+AAB-",
    "+2AA-",
    "+3AA-",
    "a".repeat(2049),
  ])("rejects malformed UTF7", (raw) => expect(() => decodeUtf7(raw)).toThrow());
  it("validates names and handles extensions and collision suffixes", () => {
    expect(requireFilename("Å.docx")).toBe("Å.docx");
    expect(() => requireFilename("../a")).toThrow();
    expect(stemOf("/a.docx")).toBe("a");
    expect(stemOf("/a")).toBe("a");
    expect(suggestedFilename("/a.doc", ".docx", 0)).toBe("a.docx");
    expect(suggestedFilename("/a.doc", "b.docx", 2)).toBe("b (2).docx");
    expect(suggestedFilename("/a.doc", "b", 1)).toBe("b (1)");
    expect(suggestedFilename("/a.doc", "bad/name.docx", 0)).toBe("bad_name.docx");
    expect(suggestedFilename("/a.doc", "", 0)).toBe("Untitled");
    expect(suggestedFilename("/a.doc", ".", 0)).toBe("a.");
    expect(
      Buffer.byteLength(suggestedFilename("/a.doc", `${"å".repeat(200)}.docx`, 999)),
    ).toBeLessThanOrEqual(255);
  });
  it("validates response-safe opaque locks", () => {
    expect(lockHeader(null)).toBeUndefined();
    expect(lockHeader("lock")).toBe("lock");
    expect(() => lockHeader(null, true)).toThrow();
    for (const value of ["", "bad\n", "å", "x".repeat(1025)])
      expect(() => lockHeader(value)).toThrow();
  });
});
