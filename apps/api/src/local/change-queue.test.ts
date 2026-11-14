import type { ChangeInput } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { CHANGE_BATCH, createChangeQueue } from "./change-queue.js";

type Write = [string, ChangeInput[]];

function recorder() {
  const writes: Write[] = [];
  const write = vi.fn(async (root: string, items: readonly ChangeInput[]) => {
    writes.push([root, [...items]]);
  });
  return { writes, write };
}

describe("createChangeQueue", () => {
  it("writes one tick's changes together, per root and in order", async () => {
    const { writes, write } = recorder();
    const queue = createChangeQueue({ write, onError: vi.fn() });
    const content = { sha256: "c".repeat(64), size: 4, mtimeNs: 9n, ino: 3n, ctimeNs: 10n };
    queue.record("files", { kind: "changed", path: "alice/a.txt", content });
    queue.record("photos", { kind: "changed", path: "b.jpg" });
    queue.record("files", { kind: "moved", path: "alice/a.txt", target: "alice/b.txt" });
    expect(write).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(writes).toEqual([
      [
        "files",
        [
          { path: "alice/a.txt", content },
          { path: "alice/a.txt", targetPath: "alice/b.txt" },
        ],
      ],
      ["photos", [{ path: "b.jpg" }]],
    ]);
  });

  it("splits a large tick into bounded writes", async () => {
    const { writes, write } = recorder();
    const queue = createChangeQueue({ write, onError: vi.fn() });
    for (let i = 0; i < CHANGE_BATCH + 1; i += 1) {
      queue.record("files", { kind: "changed", path: `alice/${i}.txt` });
    }
    await queue.flush();
    expect(writes.map(([, items]) => items.length)).toEqual([CHANGE_BATCH, 1]);
    expect(writes[1]?.[1]).toEqual([{ path: `alice/${CHANGE_BATCH}.txt` }]);
  });

  it("finishes one write before starting the next", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const write = vi.fn(async (_root: string, items: readonly ChangeInput[]) => {
      const path = items[0]?.path ?? "";
      order.push(`start ${path}`);
      if (path === "first") await gate;
      order.push(`end ${path}`);
    });
    const queue = createChangeQueue({ write, onError: vi.fn() });
    queue.record("files", { kind: "changed", path: "first" });
    const first = queue.flush();
    queue.record("files", { kind: "changed", path: "second" });
    const second = queue.flush();
    await vi.waitFor(() => expect(order).toEqual(["start first"]));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start first", "end first", "start second", "end second"]);
  });

  it("reports a failed write and keeps writing later changes", async () => {
    const write = vi
      .fn<(root: string, items: readonly ChangeInput[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("database down"))
      .mockResolvedValue(undefined);
    const onError = vi.fn(() => {
      throw new Error("the handler broke too");
    });
    const queue = createChangeQueue({ write, onError });
    queue.record("files", { kind: "changed", path: "lost.txt" });
    await queue.flush();
    expect(onError).toHaveBeenCalledWith(new Error("database down"));
    queue.record("files", { kind: "changed", path: "kept.txt" });
    await queue.flush();
    expect(write).toHaveBeenLastCalledWith("files", [{ path: "kept.txt" }]);
  });

  it("flushes nothing when nothing was recorded, and writes a flushed tick only once", async () => {
    const { write } = recorder();
    const queue = createChangeQueue({ write, onError: vi.fn() });
    await queue.flush();
    expect(write).not.toHaveBeenCalled();
    queue.record("files", { kind: "changed", path: "a.txt" });
    await queue.flush();
    // The tick's own drain finds nothing left to write.
    await new Promise((resolve) => setImmediate(resolve));
    await queue.flush();
    expect(write).toHaveBeenCalledOnce();
  });
});
