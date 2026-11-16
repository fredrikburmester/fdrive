import { ROUTES, TrashSettings } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { SettingsRepo } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { createTrashSettingsService } from "./settings.js";
import { registerTrashSettingsRoutes } from "./settings-routes.js";

function buildApp(isAdmin: boolean) {
  const values = new Map<string, unknown>();
  const settings: Pick<SettingsRepo, "get" | "set"> = {
    get: async <T>(key: string) => (values.get(key) ?? null) as T | null,
    set: async (key, value) => {
      values.set(key, value);
    },
  };
  const service = createTrashSettingsService({ settings });
  const principal: Principal = {
    accountId: "323e4567-e89b-42d3-a456-426614174000",
    identityId: "223e4567-e89b-42d3-a456-426614174000",
    username: "alice",
    storage: {} as StorageProvider,
    isAdmin,
  };
  return createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/fdrive",
      FDRIVE_STORAGE_ROOT: "/srv/files",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    }),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    version: "test",
    startedAt: new Date(0),
    principalResolver: async () => principal,
    setupRequired: async () => false,
    registerRoutes: (groups) => registerTrashSettingsRoutes(groups, { service }),
  });
}

function put(app: ReturnType<typeof buildApp>, body: unknown) {
  return app.request(ROUTES.system.trash, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
    body: JSON.stringify(body),
  });
}

describe("Trash settings routes", () => {
  it("reads 30 days by default and keeps what an administrator saves", async () => {
    const app = buildApp(true);
    const read = async () =>
      TrashSettings.parse(await (await app.request(ROUTES.trash.settings)).json());
    expect(await read()).toEqual({ retentionDays: 30 });

    const response = await put(app, { retentionDays: 7 });
    expect(response.status).toBe(200);
    expect(TrashSettings.parse(await response.json())).toEqual({ retentionDays: 7 });
    expect(await read()).toEqual({ retentionDays: 7 });
  });

  it("offers no way to turn Trash off or move it", async () => {
    const app = buildApp(true);
    for (const body of [
      { retentionDays: 30, enabled: false },
      { retentionDays: 30, path: "/Bin" },
      { retentionDays: 0 },
      { retentionDays: 3651 },
      {},
    ]) {
      expect((await put(app, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await app.request(ROUTES.system.trash)).status).toBe(404);
  });

  it("lets anyone read the setting and only an administrator change it", async () => {
    const app = buildApp(false);
    expect((await app.request(ROUTES.trash.settings)).status).toBe(200);
    expect((await put(app, { retentionDays: 7 })).status).toBe(403);
  });
});
