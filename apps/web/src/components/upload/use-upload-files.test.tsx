// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUploadStore } from "@/lib/upload/store";
import { useUploadFiles } from "./use-upload-files";

afterEach(() => {
  vi.restoreAllMocks();
  useUploadStore.getState().reset();
});
it("enqueues the replacement once the conflict is resolved", () => {
  const enqueue = vi.spyOn(useUploadStore.getState(), "enqueue").mockImplementation(() => {});
  const { result } = renderHook(useUploadFiles);
  const files = [{ file: new File(["data"], "same.txt"), relativePath: "same.txt" }];
  act(() => result.current.uploadFiles(files, "/dest", new Set(["same.txt"])));
  expect(result.current.conflictDialog.open).toBe(true);
  act(() => result.current.conflictDialog.onReplace());
  expect(enqueue).toHaveBeenCalledWith([
    expect.objectContaining({ targetPath: "/dest/same.txt", status: "queued" }),
  ]);
  expect(result.current.conflictDialog.open).toBe(false);
});
it("handles empty selections, skip and cancellation", () => {
  const enqueue = vi.spyOn(useUploadStore.getState(), "enqueue").mockImplementation(() => {});
  const { result } = renderHook(useUploadFiles);
  act(() => result.current.uploadFiles([], "/", new Set()));
  act(() => result.current.conflictDialog.onSkip());
  expect(enqueue).not.toHaveBeenCalled();
  const files = [{ file: new File(["data"], "same.txt"), relativePath: "same.txt" }];
  act(() => result.current.uploadFiles(files, "/", new Set(["same.txt"])));
  act(() => result.current.conflictDialog.onCancel());
  expect(enqueue).not.toHaveBeenCalled();
  act(() => result.current.uploadFiles(files, "/", new Set(["same.txt"])));
  act(() => result.current.conflictDialog.onSkip());
  expect(enqueue).toHaveBeenCalledWith([
    expect.objectContaining({ targetPath: "/same.txt", status: "skipped" }),
  ]);
});
