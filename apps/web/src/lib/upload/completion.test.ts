import { describe, expect, it } from "vitest";
import { uploadCompletions } from "./completion";
import type { UploadItem, UploadStatus } from "./types";

function item(id: string, status: UploadStatus, batchId = "batch"): UploadItem {
  return {
    id,
    status,
    batchId,
    identityId: "login",
    file: new File(["x"], id),
    targetPath: `/${id}`,
    relativePath: id,
    size: 1,
    progress: 0,
    attempts: 1,
  };
}
describe("upload completion", () => {
  it("waits for the entire batch and counts mixed outcomes without announcing each file", () => {
    expect(uploadCompletions([item("a", "done"), item("b", "uploading")])).toEqual([]);
    const results = uploadCompletions([
      item("a", "done"),
      item("b", "error"),
      item("c", "skipped"),
      item("d", "cancelled"),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      message: "1 uploaded · 1 failed · 1 skipped · 1 cancelled",
      hasFailures: true,
    });
  });
  it("separates batches and ignores legacy ungrouped entries", () => {
    const { batchId: _batchId, ...legacy } = item("legacy", "done");
    expect(
      uploadCompletions([legacy, item("a", "done"), item("b", "done", "other")]).map(
        (result) => result.batchId,
      ),
    ).toEqual(["batch", "other"]);
  });
});
