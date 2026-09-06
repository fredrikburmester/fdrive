import { describe, expect, it } from "vitest";
import type { DraggedPathsCarrier } from "./dnd";
import { INTERNAL_DND_TYPE, readDraggedPaths, writeDraggedPaths } from "./dnd";

function fakeCarrier(initial: Record<string, string> = {}): DraggedPathsCarrier {
  const map = new Map(Object.entries(initial));
  return {
    setData: (format, data) => {
      map.set(format, data);
    },
    getData: (format) => map.get(format) ?? "",
  };
}

describe("writeDraggedPaths / readDraggedPaths", () => {
  it("round-trips a list of paths", () => {
    const dt = fakeCarrier();
    writeDraggedPaths(dt, ["/a", "/b"]);
    expect(readDraggedPaths(dt)).toEqual(["/a", "/b"]);
  });

  it("returns null when there is no internal drag data", () => {
    expect(readDraggedPaths(fakeCarrier())).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const dt = fakeCarrier({ [INTERNAL_DND_TYPE]: "not json" });
    expect(readDraggedPaths(dt)).toBeNull();
  });

  it("returns null when the payload is not an array of strings", () => {
    const dt = fakeCarrier({ [INTERNAL_DND_TYPE]: JSON.stringify({ not: "an array" }) });
    expect(readDraggedPaths(dt)).toBeNull();
  });

  it("returns null when the array contains a non-string", () => {
    const dt = fakeCarrier({ [INTERNAL_DND_TYPE]: JSON.stringify(["/a", 1]) });
    expect(readDraggedPaths(dt)).toBeNull();
  });
});
