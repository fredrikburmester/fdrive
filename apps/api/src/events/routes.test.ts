import type { StorageProvider } from "@fdrive/core";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { createEventBus } from "./bus.js";
import { registerEventRoutes } from "./routes.js";

function notImplemented(): never {
  throw new Error("not implemented in this fake");
}

const FAKE_STORAGE: StorageProvider = {
  list: notImplemented,
  stat: notImplemented,
  statFile: notImplemented,
  download: notImplemented,
  upload: notImplemented,
  mkdir: notImplemented,
  move: notImplemented,
  copy: notImplemented,
  deleteFile: notImplemented,
  deleteDir: notImplemented,
  setModifiedAt: notImplemented,
  zip: notImplemented,
};

const PRINCIPAL: Principal = {
  accountId: "00000000-0000-4000-8000-000000000001",
  identityId: "00000000-0000-4000-8000-000000000002",
  username: "alice",
  storage: FAKE_STORAGE,
  isAdmin: false,
};

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  SFTPGO_URL: "http://localhost:8080",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

function createTestLogger(): Logger {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return logger as unknown as Logger;
}

function buildApp(pingIntervalMs?: number) {
  const bus = createEventBus();
  const config = loadConfig(REQUIRED_ENV);
  const clock = () => new Date("2024-01-01T00:00:00.000Z");
  const app = createApp({
    config,
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date("2024-01-01T00:00:00.000Z"),
    clock,
    principalResolver: async () => PRINCIPAL,
    registerRoutes: (groups) => {
      registerEventRoutes(groups, {
        bus,
        clock,
        ...(pingIntervalMs !== undefined ? { pingIntervalMs } : {}),
      });
    },
  });
  return { app, bus };
}

/** Reads the next SSE frame's raw text off `reader`. */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  if (done || value === undefined) {
    return "";
  }
  return new TextDecoder().decode(value);
}

describe("registerEventRoutes", () => {
  it("sends a ping immediately and sets no-store / no-buffering headers", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/events");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    expect(res.body).not.toBeNull();

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunk = await readChunk(reader);
    expect(chunk).toContain("event: ping");
    expect(chunk).toContain('"type":"ping"');
    await reader.cancel();
  });

  it("forwards a published fs event for the caller's identity", async () => {
    const { app, bus } = buildApp();
    const controller = new AbortController();

    const res = await app.request("/api/v1/events", { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    await readChunk(reader); // initial ping

    bus.publish({
      type: "fs",
      op: "create",
      identityId: PRINCIPAL.identityId,
      paths: ["/a.txt"],
      at: "2024-01-01T00:00:01.000Z",
    });

    const chunk = await readChunk(reader);
    expect(chunk).toContain("event: fs");
    expect(chunk).toContain('"op":"create"');
    expect(chunk).toContain("/a.txt");

    controller.abort();
    await reader.cancel();
  });

  it("does not forward an event published for a different identity", async () => {
    const { app, bus } = buildApp(20);
    const controller = new AbortController();

    const res = await app.request("/api/v1/events", { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    await readChunk(reader); // initial ping

    bus.publish({
      type: "fs",
      op: "create",
      identityId: "someone-else",
      paths: ["/a.txt"],
      at: "2024-01-01T00:00:01.000Z",
    });

    // The next thing to arrive should be a periodic ping, not the event
    // above (which was never delivered to this subscriber).
    const chunk = await readChunk(reader);
    expect(chunk).toContain("event: ping");

    controller.abort();
    await reader.cancel();
  });

  it("unsubscribes when the request is aborted", async () => {
    const { app, bus } = buildApp();
    const controller = new AbortController();

    await app.request("/api/v1/events", { signal: controller.signal });

    expect(bus.subscriberCount(PRINCIPAL.identityId)).toBe(1);

    controller.abort();
    // Let the abort event's listeners (and the cleanup they trigger) run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bus.subscriberCount()).toBe(0);
  });

  it("cleans up immediately when the request arrives already aborted", async () => {
    const { app, bus } = buildApp();
    const controller = new AbortController();
    controller.abort();

    await app.request("/api/v1/events", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bus.subscriberCount()).toBe(0);
  });
});
