import { describe, expect, it } from "vitest";
import { TERMINAL_STATUSES, type UploadItem, withoutError } from "./types.js";

function makeItem(overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    id: "1",
    file: new File(["hello"], "hello.txt"),
    targetPath: "/dest/hello.txt",
    relativePath: "hello.txt",
    size: 5,
    status: "queued",
    progress: 0,
    attempts: 0,
    ...overrides,
  };
}

describe("withoutError", () => {
  it("removes the error field when present", () => {
    const item = makeItem({ status: "error", error: "boom" });
    const result = withoutError(item);
    expect(result.error).toBeUndefined();
    expect("error" in result).toBe(false);
  });

  it("returns the same reference when there is no error", () => {
    const item = makeItem();
    expect(withoutError(item)).toBe(item);
  });
});

describe("TERMINAL_STATUSES", () => {
  it("contains exactly the finished statuses", () => {
    expect(Array.from(TERMINAL_STATUSES).sort()).toEqual(
      ["cancelled", "done", "error", "skipped"].sort(),
    );
  });

  it("does not contain the active statuses", () => {
    expect(TERMINAL_STATUSES.has("queued")).toBe(false);
    expect(TERMINAL_STATUSES.has("uploading")).toBe(false);
  });
});
