import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DndDataTransferLike,
  endDragSession,
  getActiveDragPaths,
  INTERNAL_DND_TYPE,
  isExternalFileDrag,
  readDraggedPaths,
  startDragSession,
  subscribeDragSession,
  writeDraggedPaths,
} from "./dnd.ts";

class FakeDataTransfer implements DndDataTransferLike {
  private data: Record<string, string> = {};

  constructor(public types: string[] = []) {}

  getData(format: string): string {
    return this.data[format] ?? "";
  }

  setData(format: string, value: string): void {
    this.data[format] = value;
    if (!this.types.includes(format)) {
      this.types.push(format);
    }
  }
}

describe("writeDraggedPaths / readDraggedPaths", () => {
  it("round-trips a list of paths", () => {
    const dt = new FakeDataTransfer();
    writeDraggedPaths(dt, ["/a", "/b/c"]);
    expect(readDraggedPaths(dt)).toEqual(["/a", "/b/c"]);
  });

  it("returns null when the internal type is absent", () => {
    const dt = new FakeDataTransfer(["Files"]);
    expect(readDraggedPaths(dt)).toBeNull();
  });

  it("returns null when the payload is empty", () => {
    const dt = new FakeDataTransfer([INTERNAL_DND_TYPE]);
    expect(readDraggedPaths(dt)).toBeNull();
  });

  it("returns null when the payload is not valid JSON", () => {
    const dt = new FakeDataTransfer([INTERNAL_DND_TYPE]);
    dt.setData(INTERNAL_DND_TYPE, "{not json");
    expect(readDraggedPaths(dt)).toBeNull();
  });

  it("returns null when the payload is not an array of strings", () => {
    const dt = new FakeDataTransfer([INTERNAL_DND_TYPE]);
    dt.setData(INTERNAL_DND_TYPE, JSON.stringify({ a: 1 }));
    expect(readDraggedPaths(dt)).toBeNull();

    dt.setData(INTERNAL_DND_TYPE, JSON.stringify([1, 2]));
    expect(readDraggedPaths(dt)).toBeNull();
  });
});

describe("isExternalFileDrag", () => {
  it("is true for an OS file drag", () => {
    expect(isExternalFileDrag(new FakeDataTransfer(["Files"]))).toBe(true);
  });

  it("is false for fdrive's own internal drag, even if it also carries Files", () => {
    expect(isExternalFileDrag(new FakeDataTransfer(["Files", INTERNAL_DND_TYPE]))).toBe(false);
  });

  it("is false when there is no Files type", () => {
    expect(isExternalFileDrag(new FakeDataTransfer(["text/plain"]))).toBe(false);
  });
});

describe("drag session", () => {
  afterEach(() => {
    endDragSession();
  });

  it("has no active paths before any session starts", () => {
    expect(getActiveDragPaths()).toBeNull();
  });

  it("records the dragged paths once a session starts", () => {
    startDragSession(["/a", "/b"]);
    expect(getActiveDragPaths()).toEqual(["/a", "/b"]);
  });

  it("clears the active paths when the session ends", () => {
    startDragSession(["/a"]);
    endDragSession();
    expect(getActiveDragPaths()).toBeNull();
  });

  it("notifies subscribers on start and end", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDragSession(listener);

    startDragSession(["/a"]);
    expect(listener).toHaveBeenCalledTimes(1);

    endDragSession();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    startDragSession(["/b"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
