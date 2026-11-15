import { Client } from "pg";

/**
 * The subset of a Postgres `LISTEN` connection the listener needs. Modeled
 * as plain callbacks (rather than exposing `pg.Client`'s `EventEmitter`
 * surface directly) so tests can supply a trivial fake with no real
 * connection.
 */
export interface NotificationClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string): Promise<unknown>;
  onNotification(listener: (channel: string, payload: string) => void): void;
  onError(listener: (error: unknown) => void): void;
}

/**
 * The subset of `pg.Client` (an `EventEmitter`) `createPgNotificationClient`
 * needs. Extracted as its own type so tests can supply a plain fake instead
 * of a real socket.
 */
export interface PgClientLike {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  on(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

/**
 * Wraps a `pg.Client`-like object as a `NotificationClient`. `makeClient`
 * defaults to a real `pg.Client` with TCP keepalive, so a connection that
 * dies without closing is noticed, and is overridable for tests, since a
 * real `pg.Client`'s `notification`/`error`/`end` events cannot be
 * triggered without a live connection.
 */
export function createPgNotificationClient(
  connectionString: string,
  makeClient: (connectionString: string) => PgClientLike = (cs) =>
    new Client({ connectionString: cs, keepAlive: true }) as unknown as PgClientLike,
): NotificationClient {
  const client = makeClient(connectionString);
  return {
    connect: async () => {
      await client.connect();
    },
    end: async () => {
      await client.end();
    },
    query: (text: string) => client.query(text),
    onNotification(listener) {
      client.on("notification", (message) => {
        listener(message.channel, message.payload ?? "");
      });
    },
    onError(listener) {
      client.on("error", listener);
      client.on("end", () => listener(new Error("notifications: connection closed")));
    },
  };
}

/** Exponential backoff capped at 30s: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... */
export function defaultReconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export interface NotificationLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface NotificationListenerDeps {
  /** The channels to `LISTEN` on, as Postgres identifiers. */
  readonly channels: readonly string[];
  readonly createClient: () => NotificationClient;
  /** Hears each notification, in the order they arrive. */
  readonly onNotification: (channel: string, payload: string) => void;
  /**
   * Runs each time the connection listens again, the first time included:
   * whatever was sent while it was down was not heard, so look now.
   */
  readonly onListening: () => void;
  readonly logger: NotificationLogger;
  readonly reconnectDelayMs?: (attempt: number) => number;
  /** Overrides `setTimeout` for reconnect scheduling; tests inject a synchronous stub. */
  readonly scheduleTimeout?: (fn: () => void, ms: number) => void;
}

export interface NotificationListener {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * One `LISTEN` connection that reconnects with backoff after any error. A
 * notification sent while it is down is lost, so `onListening` runs every
 * time it listens again and the caller reads what it missed.
 */
export function createNotificationListener(deps: NotificationListenerDeps): NotificationListener {
  const reconnectDelayMs = deps.reconnectDelayMs ?? defaultReconnectDelayMs;
  let cancelReconnect: (() => void) | null = null;
  const scheduleTimeout =
    deps.scheduleTimeout ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      cancelReconnect = () => clearTimeout(timer);
    });

  let stopped = true;
  let attempt = 0;
  let client: NotificationClient | null = null;
  let generation = 0;
  let reconnectPending = false;
  let connecting: Promise<void> | null = null;

  function scheduleReconnect(): void {
    if (stopped || reconnectPending) return;
    reconnectPending = true;
    const scheduledGeneration = generation;
    const delay = reconnectDelayMs(attempt++);
    scheduleTimeout(() => {
      if (stopped || generation !== scheduledGeneration) return;
      cancelReconnect = null;
      void (async () => {
        // A slow connect may outlast the delay; do not consume its only retry.
        await connecting;
        if (stopped || generation !== scheduledGeneration) return;
        reconnectPending = false;
        await connect();
      })();
    }, delay);
  }

  async function establish(): Promise<void> {
    const connectionGeneration = generation;
    const previous = client;
    client = null;
    // Detach before closing: pg emits `end`, which must not schedule another retry.
    if (previous !== null) await previous.end().catch(() => undefined);
    if (stopped || generation !== connectionGeneration) return;
    const nextClient = deps.createClient();
    client = nextClient;
    const current = () => !stopped && client === nextClient && generation === connectionGeneration;
    nextClient.onNotification((channel, payload) => {
      if (current()) deps.onNotification(channel, payload);
    });
    nextClient.onError((error) => {
      if (!current()) return;
      deps.logger.warn({ error }, "notifications: connection error, reconnecting");
      scheduleReconnect();
    });
    try {
      await nextClient.connect();
      if (stopped || generation !== connectionGeneration) {
        await nextClient.end().catch(() => undefined);
        return;
      }
      for (const channel of deps.channels) await nextClient.query(`LISTEN ${channel}`);
      attempt = 0;
    } catch (error) {
      if (client === nextClient) client = null;
      await nextClient.end().catch(() => undefined);
      deps.logger.warn({ error }, "notifications: failed to connect, retrying");
      if (generation === connectionGeneration) scheduleReconnect();
      return;
    }
    deps.onListening();
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    if (connecting !== null) return connecting;
    connecting = establish();
    try {
      await connecting;
    } finally {
      connecting = null;
    }
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      generation += 1;
      await connect();
    },
    async stop() {
      stopped = true;
      generation += 1;
      reconnectPending = false;
      cancelReconnect?.();
      cancelReconnect = null;
      const current = client;
      client = null;
      if (current !== null) await current.end().catch(() => undefined);
      await connecting;
    },
  };
}
