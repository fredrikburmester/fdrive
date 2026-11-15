import { describe, expect, it, vi } from "vitest";
import { type BusEvent, createEventBus } from "./bus.js";
import { createIndexedSignal, INDEXED_DELAY_MS } from "./indexed.js";

describe("createIndexedSignal", () => {
  it("tells every subscriber once per burst, after the delay", async () => {
    vi.useFakeTimers();
    try {
      const bus = createEventBus();
      const received: BusEvent[] = [];
      bus.subscribe({ identityId: "a" }, (event) => received.push(event));
      bus.subscribe({ identityId: "b" }, (event) => received.push(event));
      const signal = createIndexedSignal({ bus, clock: () => new Date("2026-11-15T10:00:00Z") });

      signal.notify();
      signal.notify();
      await vi.advanceTimersByTimeAsync(INDEXED_DELAY_MS - 1);
      expect(received).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(received).toEqual([
        { type: "indexed", at: "2026-11-15T10:00:00.000Z" },
        { type: "indexed", at: "2026-11-15T10:00:00.000Z" },
      ]);

      signal.notify();
      signal.stop();
      signal.stop();
      await vi.advanceTimersByTimeAsync(INDEXED_DELAY_MS);
      expect(received).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
