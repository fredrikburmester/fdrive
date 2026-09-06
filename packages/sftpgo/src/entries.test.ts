import { describe, expect, it } from "vitest";
import { classifyKind, toEntry } from "./entries.js";

const DIR_BIT = 0x80000000;
const SYMLINK_BIT = 0x08000000;

describe("classifyKind", () => {
  it("classifies a directory", () => {
    expect(classifyKind(DIR_BIT | 0o755)).toBe("dir");
  });

  it("classifies a symlink", () => {
    expect(classifyKind(SYMLINK_BIT | 0o777)).toBe("symlink");
  });

  it("classifies a regular file", () => {
    expect(classifyKind(0o644)).toBe("file");
  });

  it("classifies anything else with a type bit set as other", () => {
    const NAMED_PIPE_BIT = 0x01000000;
    expect(classifyKind(NAMED_PIPE_BIT | 0o644)).toBe("other");
  });

  it("prefers the dir classification over symlink when both bits are set", () => {
    expect(classifyKind(DIR_BIT | SYMLINK_BIT)).toBe("dir");
  });
});

describe("toEntry", () => {
  it("converts a raw file entry", () => {
    const entry = toEntry({
      name: "a.txt",
      size: 42,
      mode: 0o644,
      last_modified: "2024-01-02T03:04:05Z",
    });
    expect(entry).toEqual({
      name: "a.txt",
      kind: "file",
      size: 42,
      modifiedAt: new Date("2024-01-02T03:04:05Z"),
      mode: 0o644,
    });
  });

  it("defaults size to 0 when absent", () => {
    const entry = toEntry({ name: "dir", mode: DIR_BIT, last_modified: "2024-01-02T03:04:05Z" });
    expect(entry.size).toBe(0);
    expect(entry.kind).toBe("dir");
  });
});
