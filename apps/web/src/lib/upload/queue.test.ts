import { describe, expect, it } from "vitest";
import {
  initialUploadQueueState,
  nextToStart,
  summarize,
  type UploadQueueState,
  uploadReducer,
} from "./queue.js";
import type { UploadItem, UploadStatus } from "./types.js";

function makeItem(id: string, overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    id,
    file: new File(["x".repeat(10)], `${id}.txt`),
    targetPath: `/dest/${id}.txt`,
    relativePath: `${id}.txt`,
    size: 10,
    status: "queued",
    progress: 0,
    attempts: 0,
    ...overrides,
  };
}

function stateWith(items: UploadItem[]): UploadQueueState {
  return uploadReducer(initialUploadQueueState, { type: "enqueue", items });
}

describe("uploadReducer / enqueue", () => {
  it("is a no-op for an empty batch", () => {
    expect(uploadReducer(initialUploadQueueState, { type: "enqueue", items: [] })).toBe(
      initialUploadQueueState,
    );
  });

  it("adds new items in order and does not duplicate order entries on re-enqueue", () => {
    const a = makeItem("a");
    const b = makeItem("b");
    let state = uploadReducer(initialUploadQueueState, { type: "enqueue", items: [a, b] });
    expect(state.order).toEqual(["a", "b"]);

    const updatedA = makeItem("a", { status: "done", progress: 1 });
    state = uploadReducer(state, { type: "enqueue", items: [updatedA] });
    expect(state.order).toEqual(["a", "b"]);
    expect(state.items["a"]?.status).toBe("done");
  });
});

describe("uploadReducer / start", () => {
  it("moves a queued item to uploading and increments attempts", () => {
    const state = stateWith([makeItem("a")]);
    const next = uploadReducer(state, { type: "start", id: "a" });
    expect(next.items["a"]).toMatchObject({ status: "uploading", progress: 0, attempts: 1 });
  });

  it("clears a stale error when restarting", () => {
    const state = stateWith([makeItem("a", { status: "queued", error: "old" })]);
    const next = uploadReducer(state, { type: "start", id: "a" });
    expect(next.items["a"]?.error).toBeUndefined();
  });

  it("is a no-op for an item that is not queued", () => {
    const state = stateWith([makeItem("a", { status: "uploading" })]);
    const next = uploadReducer(state, { type: "start", id: "a" });
    expect(next).toBe(state);
  });

  it("is a no-op for an unknown id", () => {
    const state = stateWith([makeItem("a")]);
    expect(uploadReducer(state, { type: "start", id: "missing" })).toBe(state);
  });
});

describe("uploadReducer / progress", () => {
  it("sets a clamped fraction while uploading", () => {
    const state = stateWith([makeItem("a", { status: "uploading", size: 100 })]);
    const next = uploadReducer(state, { type: "progress", id: "a", loaded: 50 });
    expect(next.items["a"]?.progress).toBe(0.5);
  });

  it("clamps above 1", () => {
    const state = stateWith([makeItem("a", { status: "uploading", size: 100 })]);
    const next = uploadReducer(state, { type: "progress", id: "a", loaded: 500 });
    expect(next.items["a"]?.progress).toBe(1);
  });

  it("treats a zero-size file as fully progressed", () => {
    const state = stateWith([makeItem("a", { status: "uploading", size: 0 })]);
    const next = uploadReducer(state, { type: "progress", id: "a", loaded: 0 });
    expect(next.items["a"]?.progress).toBe(1);
  });

  it("treats a NaN fraction as 0 progress", () => {
    const state = stateWith([makeItem("a", { status: "uploading", size: 100 })]);
    const next = uploadReducer(state, { type: "progress", id: "a", loaded: Number.NaN });
    expect(next.items["a"]?.progress).toBe(0);
  });

  it("is a no-op when not uploading", () => {
    const state = stateWith([makeItem("a", { status: "queued" })]);
    const next = uploadReducer(state, { type: "progress", id: "a", loaded: 5 });
    expect(next).toBe(state);
  });
});

describe("uploadReducer / succeed", () => {
  it("marks the item done at full progress and clears any error", () => {
    const state = stateWith([
      makeItem("a", { status: "uploading", progress: 0.4, error: "flaky" }),
    ]);
    const next = uploadReducer(state, { type: "succeed", id: "a" });
    expect(next.items["a"]).toMatchObject({ status: "done", progress: 1 });
    expect(next.items["a"]?.error).toBeUndefined();
  });
});

describe("uploadReducer / fail", () => {
  it("marks an uploading item as errored with a message", () => {
    const state = stateWith([makeItem("a", { status: "uploading" })]);
    const next = uploadReducer(state, { type: "fail", id: "a", message: "500" });
    expect(next.items["a"]).toMatchObject({ status: "error", error: "500" });
  });

  it("is a no-op for an item that is not uploading", () => {
    const state = stateWith([makeItem("a", { status: "queued" })]);
    const next = uploadReducer(state, { type: "fail", id: "a", message: "500" });
    expect(next).toBe(state);
  });
});

describe("uploadReducer / skip", () => {
  it("marks a queued item as skipped", () => {
    const state = stateWith([makeItem("a")]);
    const next = uploadReducer(state, { type: "skip", id: "a" });
    expect(next.items["a"]?.status).toBe("skipped");
  });

  it("is a no-op for an item that is not queued", () => {
    const state = stateWith([makeItem("a", { status: "done" })]);
    const next = uploadReducer(state, { type: "skip", id: "a" });
    expect(next).toBe(state);
  });
});

describe("uploadReducer / cancel", () => {
  it("cancels a queued item", () => {
    const state = stateWith([makeItem("a")]);
    const next = uploadReducer(state, { type: "cancel", id: "a" });
    expect(next.items["a"]?.status).toBe("cancelled");
  });

  it("cancels an uploading item and clears its error", () => {
    const state = stateWith([makeItem("a", { status: "uploading", error: "x" })]);
    const next = uploadReducer(state, { type: "cancel", id: "a" });
    expect(next.items["a"]?.status).toBe("cancelled");
    expect(next.items["a"]?.error).toBeUndefined();
  });

  it("is a no-op for an already finished item", () => {
    const state = stateWith([makeItem("a", { status: "done" })]);
    const next = uploadReducer(state, { type: "cancel", id: "a" });
    expect(next).toBe(state);
  });
});

describe("uploadReducer / retry", () => {
  it("requeues an errored item and clears the error", () => {
    const state = stateWith([makeItem("a", { status: "error", error: "boom", progress: 0.3 })]);
    const next = uploadReducer(state, { type: "retry", id: "a" });
    expect(next.items["a"]).toMatchObject({ status: "queued", progress: 0 });
    expect(next.items["a"]?.error).toBeUndefined();
  });

  it("requeues a cancelled item", () => {
    const state = stateWith([makeItem("a", { status: "cancelled" })]);
    const next = uploadReducer(state, { type: "retry", id: "a" });
    expect(next.items["a"]?.status).toBe("queued");
  });

  it("is a no-op for a queued or done item", () => {
    const doneState = stateWith([makeItem("a", { status: "done" })]);
    expect(uploadReducer(doneState, { type: "retry", id: "a" })).toBe(doneState);

    const queuedState = stateWith([makeItem("a")]);
    expect(uploadReducer(queuedState, { type: "retry", id: "a" })).toBe(queuedState);
  });
});

describe("uploadReducer / clearFinished", () => {
  it("removes done, error, skipped, and cancelled items but keeps active ones", () => {
    const state = stateWith([
      makeItem("a", { status: "done" }),
      makeItem("b", { status: "error" }),
      makeItem("c", { status: "skipped" }),
      makeItem("d", { status: "cancelled" }),
      makeItem("e", { status: "queued" }),
      makeItem("f", { status: "uploading" }),
    ]);
    const next = uploadReducer(state, { type: "clearFinished" });
    expect(next.order).toEqual(["e", "f"]);
    expect(Object.keys(next.items).sort()).toEqual(["e", "f"]);
  });

  it("is a no-op when nothing is finished", () => {
    const state = stateWith([makeItem("a", { status: "queued" })]);
    expect(uploadReducer(state, { type: "clearFinished" })).toBe(state);
  });
});

describe("nextToStart", () => {
  it("returns queued items up to the concurrency limit, in order", () => {
    const state = stateWith([makeItem("a"), makeItem("b"), makeItem("c")]);
    const started = nextToStart(state, 2);
    expect(started.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("accounts for items already uploading", () => {
    const state = stateWith([makeItem("a", { status: "uploading" }), makeItem("b"), makeItem("c")]);
    const started = nextToStart(state, 2);
    expect(started.map((i) => i.id)).toEqual(["b"]);
  });

  it("returns nothing once concurrency is saturated", () => {
    const state = stateWith([
      makeItem("a", { status: "uploading" }),
      makeItem("b", { status: "uploading" }),
      makeItem("c"),
    ]);
    expect(nextToStart(state, 2)).toEqual([]);
  });

  it("defaults concurrency to 4", () => {
    const items = ["a", "b", "c", "d", "e"].map((id) => makeItem(id));
    const state = stateWith(items);
    expect(nextToStart(state).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("skips non-queued items when scanning for candidates", () => {
    const state = stateWith([
      makeItem("a", { status: "done" }),
      makeItem("b", { status: "error" }),
      makeItem("c"),
    ]);
    expect(nextToStart(state, 4).map((i) => i.id)).toEqual(["c"]);
  });
});

describe("summarize", () => {
  it("summarizes an empty queue", () => {
    expect(summarize(initialUploadQueueState)).toEqual({
      total: 0,
      done: 0,
      failed: 0,
      inFlight: 0,
      bytesTotal: 0,
      bytesDone: 0,
      overallProgress: 0,
    });
  });

  it("counts by status and computes byte totals", () => {
    const state = stateWith([
      makeItem("a", { status: "done", size: 100, progress: 1 }),
      makeItem("b", { status: "uploading", size: 100, progress: 0.5 }),
      makeItem("c", { status: "queued", size: 100, progress: 0 }),
      makeItem("d", { status: "error", size: 100, progress: 0.2 }),
    ]);
    const summary = summarize(state);
    expect(summary.total).toBe(4);
    expect(summary.done).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.inFlight).toBe(1);
    expect(summary.bytesTotal).toBe(400);
    expect(summary.bytesDone).toBe(100 + 50 + 0 + 20);
    expect(summary.overallProgress).toBeCloseTo(170 / 400);
  });

  it("excludes skipped and cancelled items from byte totals", () => {
    const state = stateWith([
      makeItem("a", { status: "skipped", size: 100 }),
      makeItem("b", { status: "cancelled", size: 100 }),
      makeItem("c", { status: "done", size: 50, progress: 1 }),
    ]);
    const summary = summarize(state);
    expect(summary.bytesTotal).toBe(50);
    expect(summary.bytesDone).toBe(50);
    expect(summary.overallProgress).toBe(1);
  });

  it("reports full progress when every item is inactive", () => {
    const state = stateWith([makeItem("a", { status: "skipped", size: 100 })]);
    expect(summarize(state).overallProgress).toBe(1);
  });

  it("skips ids in order that have no matching item", () => {
    const summary = summarize({ items: {}, order: ["missing"] });
    expect(summary.total).toBe(0);
  });

  it("covers every status branch for counting", () => {
    const statuses: UploadStatus[] = [
      "queued",
      "uploading",
      "done",
      "error",
      "skipped",
      "cancelled",
    ];
    const state = stateWith(statuses.map((status, i) => makeItem(`s${i}`, { status })));
    const summary = summarize(state);
    expect(summary.total).toBe(6);
  });
});
