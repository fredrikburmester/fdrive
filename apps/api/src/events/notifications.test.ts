import { describe, expect, it, vi } from "vitest";
import {
  createNotificationListener,
  createPgNotificationClient,
  defaultReconnectDelayMs,
  type NotificationClient,
  type NotificationListenerDeps,
  type PgClientLike,
} from "./notifications.js";

function createFakeClient() {
  let notificationListener: ((channel: string, payload: string) => void) | null = null;
  let errorListener: ((error: unknown) => void) | null = null;
  const state = {
    connectCalls: 0,
    queries: [] as string[],
    ended: false,
    connectImpl: async (): Promise<void> => undefined,
  };
  const client: NotificationClient = {
    async connect() {
      state.connectCalls += 1;
      await state.connectImpl();
    },
    async end() {
      state.ended = true;
    },
    async query(text) {
      state.queries.push(text);
    },
    onNotification(listener) {
      notificationListener = listener;
    },
    onError(listener) {
      errorListener = listener;
    },
  };
  return {
    client,
    state,
    notify: (channel: string, payload = "") => notificationListener?.(channel, payload),
    fail: (error: unknown) => errorListener?.(error),
  };
}

function listen(
  overrides: Partial<NotificationListenerDeps> & Pick<NotificationListenerDeps, "createClient">,
) {
  const heard: [string, string][] = [];
  const warnings: string[] = [];
  let listening = 0;
  const listener = createNotificationListener({
    channels: ["idx_changes", "idx_events"],
    onNotification: (channel, payload) => heard.push([channel, payload]),
    onListening: () => {
      listening += 1;
    },
    logger: { warn: (_data, message) => warnings.push(message) },
    ...overrides,
  });
  return { listener, heard, warnings, listening: () => listening };
}

describe("createNotificationListener", () => {
  it("listens on every channel, says so, and passes notifications on", async () => {
    const fake = createFakeClient();
    const { listener, heard, listening } = listen({ createClient: () => fake.client });

    await listener.start();
    fake.notify("idx_changes", "files");
    fake.notify("idx_events", "files");

    expect(fake.state.queries).toEqual(["LISTEN idx_changes", "LISTEN idx_events"]);
    expect(listening()).toBe(1);
    expect(heard).toEqual([
      ["idx_changes", "files"],
      ["idx_events", "files"],
    ]);
    await listener.stop();
    expect(fake.state.ended).toBe(true);
    fake.notify("idx_changes", "files");
    expect(heard).toHaveLength(2);
  });

  it("reconnects with backoff after a connection error and says it listens again", async () => {
    const fake = createFakeClient();
    const scheduled: [() => void, number][] = [];
    const { listener, listening, warnings } = listen({
      createClient: () => fake.client,
      scheduleTimeout: (fn, ms) => scheduled.push([fn, ms]),
    });
    await listener.start();

    fake.fail(new Error("connection reset"));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.[1]).toBe(defaultReconnectDelayMs(0));
    expect(warnings).toEqual(["notifications: connection error, reconnecting"]);

    scheduled[0]?.[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.state.connectCalls).toBe(2);
    expect(listening()).toBe(2);
    await listener.stop();
  });

  it("retries with backoff when the first connect fails, without saying it listens", async () => {
    const fake = createFakeClient();
    fake.state.connectImpl = async () => {
      throw new Error("refused");
    };
    const scheduled: [() => void, number][] = [];
    const { listener, listening } = listen({
      createClient: () => fake.client,
      scheduleTimeout: (fn, ms) => scheduled.push([fn, ms]),
    });

    await listener.start();

    expect(scheduled).toHaveLength(1);
    expect(listening()).toBe(0);
    await listener.stop();
  });

  it("does not reconnect once stopped", async () => {
    const fake = createFakeClient();
    const scheduled: (() => void)[] = [];
    const { listener } = listen({
      createClient: () => fake.client,
      scheduleTimeout: (fn) => scheduled.push(fn),
    });
    await listener.start();
    fake.fail(new Error("boom"));
    await listener.stop();

    scheduled[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.state.connectCalls).toBe(1);
  });

  it("swallows an error from end() and is a no-op before start()", async () => {
    const fake = createFakeClient();
    fake.client.end = async () => {
      throw new Error("already closed");
    };
    const { listener } = listen({ createClient: () => fake.client });
    await expect(listener.stop()).resolves.toBeUndefined();
    await listener.start();
    await expect(listener.stop()).resolves.toBeUndefined();
  });

  it("coalesces repeated errors, closes the old client and ignores stale callbacks after a restart", async () => {
    const first = createFakeClient();
    const second = createFakeClient();
    const scheduled: (() => void)[] = [];
    let creations = 0;
    const { listener, heard } = listen({
      createClient: () => (++creations === 1 ? first.client : second.client),
      scheduleTimeout: (fn) => scheduled.push(fn),
    });
    await listener.start();
    await listener.start();
    expect(creations).toBe(1);
    first.fail(new Error("error"));
    first.fail(new Error("end"));
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.state.ended).toBe(true);
    expect(creations).toBe(2);
    first.fail(new Error("stale"));
    first.notify("idx_changes", "stale");
    expect(scheduled).toHaveLength(1);
    expect(heard).toEqual([]);
    second.fail(new Error("retry"));
    await listener.stop();
    await listener.start();
    scheduled[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(creations).toBe(3);
    await listener.stop();
  });

  it("cancels real reconnect timers and recovers when closing the old client fails", async () => {
    vi.useFakeTimers();
    const first = createFakeClient();
    const second = createFakeClient();
    let creations = 0;
    const { listener } = listen({
      createClient: () => (++creations === 1 ? first.client : second.client),
    });
    try {
      await listener.start();
      vi.spyOn(first.client, "end").mockRejectedValue(new Error("already disconnected"));
      first.fail(new Error("connection reset"));
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(creations).toBe(2);
      second.fail(new Error("retry"));
      expect(vi.getTimerCount()).toBe(1);
      await listener.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10000);
      expect(creations).toBe(2);
    } finally {
      await listener.stop();
      vi.useRealTimers();
    }
  });

  it("stops a slow connection without LISTEN even if closing it fails", async () => {
    const fake = createFakeClient();
    let finishConnect!: () => void;
    fake.state.connectImpl = () =>
      new Promise<void>((resolve) => {
        finishConnect = resolve;
      });
    vi.spyOn(fake.client, "end").mockRejectedValue(new Error("disconnected"));
    const { listener, listening } = listen({ createClient: () => fake.client });
    const starting = listener.start();
    const stopping = listener.stop();
    finishConnect();
    await Promise.all([starting, stopping]);
    expect(fake.state.queries).toEqual([]);
    expect(listening()).toBe(0);
  });
});

describe("defaultReconnectDelayMs", () => {
  it("doubles from 1s up to a 30s cap", () => {
    expect(defaultReconnectDelayMs(0)).toBe(1000);
    expect(defaultReconnectDelayMs(1)).toBe(2000);
    expect(defaultReconnectDelayMs(2)).toBe(4000);
    expect(defaultReconnectDelayMs(10)).toBe(30_000);
  });
});

describe("createPgNotificationClient", () => {
  it("builds a real pg.Client-backed client without connecting", () => {
    const client = createPgNotificationClient("postgres://localhost/fdrive");
    expect(typeof client.connect).toBe("function");
  });

  function fakePgClient() {
    const listeners = {
      notification: [] as ((message: { channel: string; payload?: string }) => void)[],
      error: [] as ((error: Error) => void)[],
      end: [] as (() => void)[],
    };
    const queries: string[] = [];
    const pgClient: PgClientLike = {
      connect: async () => undefined,
      end: async () => undefined,
      query: async (text) => {
        queries.push(text);
      },
      on: ((event: keyof typeof listeners, listener: never) => {
        listeners[event].push(listener);
        return pgClient;
      }) as PgClientLike["on"],
    };
    return { pgClient, listeners, queries };
  }

  it("forwards each notification's channel and payload, an empty one included", () => {
    const fake = fakePgClient();
    const client = createPgNotificationClient("postgres://x", () => fake.pgClient);
    const received: [string, string][] = [];
    client.onNotification((channel, payload) => received.push([channel, payload]));

    for (const listener of fake.listeners.notification) {
      listener({ channel: "idx_changes", payload: "files" });
      listener({ channel: "idx_events" });
    }

    expect(received).toEqual([
      ["idx_changes", "files"],
      ["idx_events", ""],
    ]);
  });

  it("forwards connection errors, treats end as an error and delegates the rest", async () => {
    const fake = fakePgClient();
    const client = createPgNotificationClient("postgres://x", () => fake.pgClient);
    const received: unknown[] = [];
    client.onError((error) => received.push(error));

    for (const listener of fake.listeners.error) listener(new Error("boom"));
    for (const listener of fake.listeners.end) listener();
    await client.connect();
    await client.query("LISTEN idx_changes");
    await client.end();

    expect(received).toHaveLength(2);
    expect(received[1]).toBeInstanceOf(Error);
    expect(fake.queries).toEqual(["LISTEN idx_changes"]);
  });
});
