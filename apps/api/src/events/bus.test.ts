import type { FsEvent, JobEvent } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import type { BusEvent } from "./bus.js";
import { createEventBus } from "./bus.js";

function makeEvent(overrides: Partial<FsEvent> = {}): FsEvent {
  return {
    type: "fs",
    op: "create",
    identityId: "identity-1",
    paths: ["/a.txt"],
    at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("createEventBus", () => {
  it("starts with no subscribers", () => {
    const bus = createEventBus();
    expect(bus.subscriberCount()).toBe(0);
  });

  it("delivers a published event to a matching subscriber", () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: "identity-1" }, (event) => received.push(event));

    const event = makeEvent();
    bus.publish(event);

    expect(received).toEqual([event]);
  });

  it("does not deliver an event to a subscriber of a different identity", () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: "identity-2" }, (event) => received.push(event));

    bus.publish(makeEvent({ identityId: "identity-1" }));

    expect(received).toEqual([]);
  });

  it("delivers to multiple subscribers of the same identity", () => {
    const bus = createEventBus();
    const receivedA: BusEvent[] = [];
    const receivedB: BusEvent[] = [];
    bus.subscribe({ identityId: "identity-1" }, (event) => receivedA.push(event));
    bus.subscribe({ identityId: "identity-1" }, (event) => receivedB.push(event));

    bus.publish(makeEvent());

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
  });

  it("reports subscriberCount for a specific identity and overall", () => {
    const bus = createEventBus();
    bus.subscribe({ identityId: "identity-1" }, () => {});
    bus.subscribe({ identityId: "identity-2" }, () => {});

    expect(bus.subscriberCount()).toBe(2);
    expect(bus.subscriberCount("identity-1")).toBe(1);
    expect(bus.subscriberCount("identity-3")).toBe(0);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    const unsubscribe = bus.subscribe({ identityId: "identity-1" }, (event) =>
      received.push(event),
    );

    unsubscribe();
    bus.publish(makeEvent());

    expect(received).toEqual([]);
    expect(bus.subscriberCount()).toBe(0);
  });

  it("treats calling unsubscribe twice as a no-op", () => {
    const bus = createEventBus();
    const unsubscribe = bus.subscribe({ identityId: "identity-1" }, () => {});

    unsubscribe();
    unsubscribe();

    expect(bus.subscriberCount()).toBe(0);
  });

  it("delivers a job event to a subscriber of the job's identity", () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: "identity-1" }, (event) => received.push(event));

    const jobEvent: JobEvent & { identityId: string } = {
      type: "job",
      identityId: "identity-1",
      at: "2024-01-01T00:00:00.000Z",
      job: {
        id: "job-1",
        kind: "compress",
        state: "running",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        progress: { processed: 0, total: null, bytes: 0 },
      },
    };
    bus.publish(jobEvent);

    expect(received).toEqual([jobEvent]);
  });

  it("swallows an error thrown by one handler and still delivers to the others", () => {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe({ identityId: "identity-1" }, () => {
      throw new Error("boom");
    });
    bus.subscribe({ identityId: "identity-1" }, (event) => received.push(event));

    expect(() => bus.publish(makeEvent())).not.toThrow();
    expect(received).toHaveLength(1);
  });
});
