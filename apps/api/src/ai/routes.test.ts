import {
  type AiSettings,
  type OrganizeRun,
  organizeRunCancelRoute,
  organizeRunRoute,
  ROUTES,
} from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import type { AiModel } from "./model.ts";
import type { OrganizeService } from "./organize/service.ts";
import { registerAiRoutes } from "./routes.ts";
import type { AiSettingsService, ResolvedAiConfig } from "./settings.ts";

const WRITE_HEADERS = { "content-type": "application/json", "x-requested-with": "fdrive" };

const RUN: OrganizeRun = {
  id: "run-1",
  state: "running",
  createdAt: "2026-09-15T10:00:00.000Z",
  updatedAt: "2026-09-15T10:00:00.000Z",
  itemCount: 2,
  activity: ["Looking at 2 items"],
};

const CONFIGURATION: AiSettings = {
  revision: 1,
  enabled: true,
  provider: "anthropic",
  model: "claude-opus-5",
  baseUrl: null,
  hasApiKey: true,
};

const SAVED: ResolvedAiConfig = {
  provider: "anthropic",
  model: "claude-opus-5",
  baseUrl: null,
  apiKey: "sk-ant-1",
};

function buildApp(
  options: {
    isAdmin?: boolean;
    saved?: ResolvedAiConfig | null;
    ping?: AiModel["ping"];
    testTimeoutMs?: number;
  } = {},
) {
  const principal: Principal = {
    accountId: "323e4567-e89b-42d3-a456-426614174000",
    identityId: "223e4567-e89b-42d3-a456-426614174000",
    username: "alice",
    storage: {} as StorageProvider,
    isAdmin: options.isAdmin ?? false,
  };
  const organize = {
    status: vi.fn(async () => ({ available: true, provider: "anthropic" as const })),
    start: vi.fn(async () => RUN),
    get: vi.fn(() => RUN),
    cancel: vi.fn(() => ({ ...RUN, state: "cancelled" as const })),
  } satisfies OrganizeService;
  const settings = {
    configuration: vi.fn(async () => CONFIGURATION),
    update: vi.fn(async () => ({ ...CONFIGURATION, revision: 2, model: "claude-sonnet-5" })),
    resolved: vi.fn(async () => SAVED),
    saved: vi.fn(async () => (options.saved === undefined ? SAVED : options.saved)),
  } satisfies AiSettingsService;
  const ping = vi.fn(options.ping ?? (async () => ({ ok: true, message: "Connected." })));
  const modelFor = vi.fn((_config: ResolvedAiConfig): AiModel => ({ start: vi.fn(), ping }));
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/fdrive",
      SFTPGO_URL: "http://sftpgo.test",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    }),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    version: "test",
    startedAt: new Date(0),
    principalResolver: async () => principal,
    registerRoutes: (groups) =>
      registerAiRoutes(groups, {
        settings,
        organize,
        modelFor,
        ...(options.testTimeoutMs !== undefined ? { testTimeoutMs: options.testTimeoutMs } : {}),
      }),
  });
  return { app, principal, organize, settings, modelFor, ping };
}

describe("AI routes", () => {
  describe("organize runs", () => {
    it("tells any signed-in person whether AI is available", async () => {
      const { app } = buildApp({ isAdmin: false });
      const response = await app.request(ROUTES.ai.status);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ available: true, provider: "anthropic" });
    });

    it("starts a run for the caller with the parsed request", async () => {
      const { app, organize, principal } = buildApp();
      const response = await app.request(ROUTES.ai.organize, {
        method: "POST",
        headers: WRITE_HEADERS,
        body: JSON.stringify({ paths: ["/a.jpg", "/b.jpg"], instructions: "  photos by year  " }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(RUN);
      expect(organize.start).toHaveBeenCalledWith(principal, {
        paths: ["/a.jpg", "/b.jpg"],
        instructions: "photos by year",
      });
    });

    it.each([
      { name: "no paths", body: JSON.stringify({ paths: [] }) },
      { name: "unknown fields", body: JSON.stringify({ paths: ["/a"], move: true }) },
      { name: "malformed JSON", body: "{" },
    ])("rejects a request with $name", async ({ body }) => {
      const { app, organize } = buildApp();
      const response = await app.request(ROUTES.ai.organize, {
        method: "POST",
        headers: WRITE_HEADERS,
        body,
      });
      expect(response.status).toBe(400);
      expect(organize.start).not.toHaveBeenCalled();
    });

    it("reads and cancels a run by id for the caller", async () => {
      const { app, organize, principal } = buildApp();
      const read = await app.request(organizeRunRoute("run-1"));
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(RUN);
      expect(organize.get).toHaveBeenCalledWith(principal, "run-1");

      const cancelled = await app.request(organizeRunCancelRoute("run-1"), {
        method: "POST",
        headers: WRITE_HEADERS,
      });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ id: "run-1", state: "cancelled" });
      expect(organize.cancel).toHaveBeenCalledWith(principal, "run-1");
    });
  });

  describe("system settings", () => {
    it("is limited to administrators", async () => {
      const { app, settings, modelFor } = buildApp({ isAdmin: false });
      expect((await app.request(ROUTES.system.ai)).status).toBe(403);
      const put = await app.request(ROUTES.system.ai, {
        method: "PUT",
        headers: WRITE_HEADERS,
        body: JSON.stringify({
          revision: 1,
          enabled: true,
          provider: "anthropic",
          model: "claude-opus-5",
          baseUrl: null,
        }),
      });
      expect(put.status).toBe(403);
      const test = await app.request(ROUTES.system.aiTest, {
        method: "POST",
        headers: WRITE_HEADERS,
      });
      expect(test.status).toBe(403);
      expect(settings.configuration).not.toHaveBeenCalled();
      expect(settings.update).not.toHaveBeenCalled();
      expect(modelFor).not.toHaveBeenCalled();
    });

    it("returns the configuration to an administrator", async () => {
      const { app } = buildApp({ isAdmin: true });
      const response = await app.request(ROUTES.system.ai);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ configuration: CONFIGURATION });
    });

    it("saves a valid update and returns the new configuration", async () => {
      const { app, settings } = buildApp({ isAdmin: true });
      const input = {
        revision: 1,
        enabled: true,
        provider: "anthropic",
        model: "claude-sonnet-5",
        baseUrl: null,
        apiKey: "sk-ant-2",
      };
      const response = await app.request(ROUTES.system.ai, {
        method: "PUT",
        headers: WRITE_HEADERS,
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        configuration: { ...CONFIGURATION, revision: 2, model: "claude-sonnet-5" },
      });
      expect(settings.update).toHaveBeenCalledWith(input);
    });

    it("rejects an invalid update", async () => {
      const { app, settings } = buildApp({ isAdmin: true });
      const response = await app.request(ROUTES.system.ai, {
        method: "PUT",
        headers: WRITE_HEADERS,
        body: JSON.stringify({
          revision: 1,
          enabled: true,
          provider: "openai_compatible",
          model: "llama3",
          baseUrl: null,
        }),
      });
      expect(response.status).toBe(400);
      expect(settings.update).not.toHaveBeenCalled();
    });
  });

  describe("connection check", () => {
    async function check(app: ReturnType<typeof buildApp>["app"]) {
      const response = await app.request(ROUTES.system.aiTest, {
        method: "POST",
        headers: WRITE_HEADERS,
      });
      expect(response.status).toBe(200);
      return response.json();
    }

    it("asks for a saved configuration first", async () => {
      const built = buildApp({ isAdmin: true, saved: null });
      expect(await check(built.app)).toEqual({
        ok: false,
        message: "Save a provider, model and key first.",
      });
      expect(built.modelFor).not.toHaveBeenCalled();
    });

    it("pings the saved configuration and returns the result", async () => {
      const built = buildApp({
        isAdmin: true,
        ping: async () => ({ ok: false, message: "Anthropic rejected the API key." }),
      });
      expect(await check(built.app)).toEqual({
        ok: false,
        message: "Anthropic rejected the API key.",
      });
      expect(built.modelFor).toHaveBeenCalledWith(SAVED);
      expect(built.ping.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    });

    it("reports a check that fails or runs out of time", async () => {
      const failing = buildApp({
        isAdmin: true,
        ping: async () => {
          throw new Error("socket closed");
        },
      });
      expect(await check(failing.app)).toEqual({
        ok: false,
        message: "The connection check did not finish in time.",
      });

      const slow = buildApp({
        isAdmin: true,
        testTimeoutMs: 5,
        ping: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
      });
      expect(await check(slow.app)).toEqual({
        ok: false,
        message: "The connection check did not finish in time.",
      });
    });
  });
});
