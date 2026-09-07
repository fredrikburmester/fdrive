import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { readinessScript } from "./ready-script.js";

it("executes without captured helpers and marks first paintable row after the matching response", () => {
  class Resource {
    constructor(
      readonly name: string,
      readonly responseEnd = 100,
      readonly duration = 70,
    ) {}
  }
  let rect = { width: 100, height: 20, bottom: 80, top: 60 };
  class Element {
    getBoundingClientRect() {
      return rect;
    }
  }
  let row: Element | null = null;
  const frames: Array<() => void> = [];
  const callbacks = new Map<string, (list: { getEntries(): Resource[] }) => void>();
  let mutation: (() => void) | undefined;
  let disconnected = false;
  let bufferSize = 0;
  const state: Record<string, unknown> = {};
  class Observer {
    static supportedEntryTypes = ["resource", "longtask"];
    constructor(readonly callback: (list: { getEntries(): Resource[] }) => void) {}
    observe(options: { type: string }) {
      callbacks.set(options.type, this.callback);
    }
  }
  runInNewContext(`(${readinessScript})("list")`, {
    window: state,
    URL,
    HTMLElement: Element,
    PerformanceResourceTiming: Resource,
    innerHeight: 1000,
    document: {
      querySelector(selector: string) {
        expect(selector).toContain("file-list");
        return row;
      },
    },
    performance: {
      now: () => 125,
      setResourceTimingBufferSize(value: number) {
        bufferSize = value;
      },
    },
    requestAnimationFrame(callback: () => void) {
      frames.push(callback);
    },
    PerformanceObserver: Observer,
    MutationObserver: class {
      constructor(callback: () => void) {
        mutation = callback;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  });
  function paint() {
    for (const frame of frames.splice(0)) frame();
  }
  function emit(type: string, entries: Resource[]) {
    const callback = callbacks.get(type);
    if (!callback) throw Error("Observer not registered");
    callback({ getEntries: () => entries });
  }
  paint();
  expect(state.fdrivePerfReady).toBeUndefined();
  row = new Element();
  mutation?.();
  paint();
  expect(state.fdrivePerfReady).toBeUndefined();
  emit("resource", [
    new Resource("http://fixture/other"),
    new Resource("http://fixture/api/v1/fs/list?path=/cold"),
  ]);
  paint();
  expect(state.fdrivePerfReady).toBeUndefined();
  rect = { ...rect, width: 0 };
  emit("resource", [new Resource("http://fixture/api/v1/fs/list?path=/flat-10k")]);
  paint();
  expect(state.fdrivePerfReady).toBeUndefined();
  rect = { width: 100, height: 20, bottom: 80, top: 60 };
  mutation?.();
  paint();
  expect(state.fdrivePerfReady).toBe(25);
  expect(disconnected).toBe(true);
  expect(bufferSize).toBe(10000);
  emit("resource", [new Resource("http://fixture/api/v1/fs/list?path=/flat-10k", 120)]);
  emit("longtask", [new Resource("task", 0, 90)]);
  paint();
  expect(state.fdrivePerfReady).toBe(25);
  expect(state.fdrivePerfStats).toEqual({
    listingRequests: 3,
    listingPaths: { "/cold": 1, "/flat-10k": 2 },
    longTasksMs: [90],
  });
});
