import { DEFAULT_STORAGE_NAME, ROUTES, SystemStorage } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { SettingsRepo } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { createStorageService } from "./storage.js";
import { registerStorageRoutes } from "./storage-routes.js";

const STORAGE_ID = "123e4567-e89b-42d3-a456-426614174000";

function harness(health = { ok: true, detail: "The storage root is a writable folder" }) {
  const values = new Map<string, unknown>();
  const settings: Pick<SettingsRepo, "get" | "set"> = {
    get: async <T>(key: string) => (values.get(key) ?? null) as T | null,
    set: async (key, value) => {
      values.set(key, value);
    },
  };
  const events: string[] = [];
  const service = createStorageService({
    storageId: STORAGE_ID,
    settings,
    folder: { health: async () => health },
    eventLog: { record: (_subsystem, _level, message) => events.push(message) },
  });
  return { service, values, events };
}

function buildApp(isAdmin: boolean, service = harness().service) {
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
    setupRequired: async () => false,
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerStorageRoutes(groups, { service }),
  });
}

const headers = { "content-type": "application/json", "x-requested-with": "fdrive" };

describe("storage service", () => {
  it("names the storage by default until it is renamed, and logs the rename", async () => {
    const h = harness();
    expect(await h.service.name()).toBe(DEFAULT_STORAGE_NAME);
    expect(await h.service.rename("  Family files  ")).toEqual({
      id: STORAGE_ID,
      name: "Family files",
      healthy: true,
      detail: "The storage root is a writable folder",
    });
    expect(await h.service.name()).toBe("Family files");
    expect(h.values.get("storage.name")).toEqual({ name: "Family files" });
    expect(h.events).toEqual(["Storage renamed: Family files"]);
  });

  it("reports the files folder's health as its guard and permissions find it", async () => {
    const h = harness({ ok: false, detail: "the folder has no marker" });
    expect(await h.service.view()).toMatchObject({
      healthy: false,
      detail: "the folder has no marker",
    });
  });

  it("refuses a name it would not show", async () => {
    await expect(harness().service.rename(" ")).rejects.toThrow();
  });
});

describe("storage routes", () => {
  it("reads and renames the storage for an administrator", async () => {
    const app = buildApp(true);
    const initial = SystemStorage.parse(await (await app.request(ROUTES.system.storage)).json());
    expect(initial).toMatchObject({ id: STORAGE_ID, name: DEFAULT_STORAGE_NAME, healthy: true });
    const renamed = await app.request(ROUTES.system.storage, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Home storage" }),
    });
    expect(renamed.status).toBe(200);
    expect(SystemStorage.parse(await renamed.json()).name).toBe("Home storage");
    for (const body of ["{", JSON.stringify({ name: "" }), JSON.stringify({ label: "x" })]) {
      const refused = await app.request(ROUTES.system.storage, { method: "PATCH", headers, body });
      expect(refused.status, body).toBe(400);
    }
  });

  it("refuses anyone else", async () => {
    const app = buildApp(false);
    expect((await app.request(ROUTES.system.storage)).status).toBe(403);
    const patch = await app.request(ROUTES.system.storage, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Mine" }),
    });
    expect(patch.status).toBe(403);
  });
});
