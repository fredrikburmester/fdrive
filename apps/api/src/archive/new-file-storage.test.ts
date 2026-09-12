import { StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { describe, expect, it, vi } from "vitest";
import { protectArchiveWrites } from "./new-file-storage.ts";

describe("archive destinations", () => {
  it("serializes separate requests for one identity even if the provider ignores no-overwrite", async () => {
    const base = createMemoryStorage();
    const upload = vi.fn<typeof base.upload>((path, body) => base.upload(path, body));
    const storage = { ...base, upload };
    const first = protectArchiveWrites(storage, "alice");
    const second = protectArchiveWrites(storage, "alice");
    const results = await Promise.allSettled([
      first.upload("/out.txt", new TextEncoder().encode("first")),
      second.upload("/out.txt", new TextEncoder().encode("second")),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { kind: "conflict" } });
    expect(base.dump()["/out.txt"]).toBe("first");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[2]).toMatchObject({ overwrite: false });
    await base.deleteFile("/out.txt");
    await expect(second.upload("/out.txt", new Uint8Array())).resolves.toBeUndefined();
  });

  it("cancels an unconsumed body on a conflict, including directories", async () => {
    const base = createMemoryStorage({ "/out/file": "kept" });
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    await expect(protectArchiveWrites(base, "alice").upload("/out", stream)).rejects.toMatchObject({
      kind: "conflict",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(base.dump()["/out/file"]).toBe("kept");
  });

  it("propagates authorization and cancellation failures without writing", async () => {
    const base = createMemoryStorage();
    const upload = vi.spyOn(base, "upload");
    const storage = protectArchiveWrites(base, "alice");
    await expect(
      storage.upload("/out", new Uint8Array(), { signal: AbortSignal.abort() }),
    ).rejects.toThrow("cancelled");
    const stat = vi.spyOn(base, "stat").mockRejectedValue(new StorageError("forbidden", "denied"));
    await expect(
      storage.upload("/out", new Uint8Array(), { signal: new AbortController().signal }),
    ).rejects.toThrow("denied");
    stat.mockRestore();
    expect(upload).not.toHaveBeenCalled();
  });
});

it("preserves conflict errors and releases the path lock if body cancellation fails", async () => {
  const base = createMemoryStorage({ "/out": "kept" });
  const cancel = vi.fn(async () => {
    throw new Error("disconnected");
  });
  const storage = protectArchiveWrites(base, "alice");
  await expect(storage.upload("/out", new ReadableStream({ cancel }))).rejects.toMatchObject({
    kind: "conflict",
  });
  expect(cancel).toHaveBeenCalledOnce();
  await base.deleteFile("/out");
  await expect(storage.upload("/out", new Uint8Array())).resolves.toBeUndefined();
});
