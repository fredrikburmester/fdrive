import { ROUTES, TrashSettings } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Identity, SettingsRepo } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { createTrashSettingsService } from "./settings.js";
import { registerTrashSettingsRoutes } from "./settings-routes.js";

const PROVIDER_ID = "123e4567-e89b-42d3-a456-426614174000";
const IDENTITY_ID = "223e4567-e89b-42d3-a456-426614174000";
const identity: Identity = {
  id: IDENTITY_ID,
  accountId: "323e4567-e89b-42d3-a456-426614174000",
  providerId: PROVIDER_ID,
  externalUsername: "alice",
  createdAt: new Date(0),
  lastLoginAt: null,
};

function buildApp(isAdmin: boolean) {
  let stored: unknown | null = null;
  const settings: Pick<SettingsRepo, "get" | "compareAndSet"> = {
    get: async <T>() => stored as T | null,
    compareAndSet: async (_key, expected, value) => {
      if (JSON.stringify(stored) !== JSON.stringify(expected)) return false;
      stored = value;
      return true;
    },
  };
  const identities = { get: async () => identity };
  const service = createTrashSettingsService({
    settings,
    identities,
    strategyFor: async () => "native",
  });
  const principal: Principal = {
    accountId: identity.accountId,
    identityId: identity.id,
    username: identity.externalUsername,
    storage: {} as StorageProvider,
    isAdmin,
  };
  return createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/fdrive",
      SFTPGO_URL: "http://sftpgo.test",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    }),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    version: "test",
    startedAt: new Date(0),
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerTrashSettingsRoutes(groups, { service, identities }),
  });
}

describe("admin Trash settings routes", () => {
  it("returns defaults and updates the active provider with revision CAS", async () => {
    const app = buildApp(true);
    const initial = TrashSettings.parse(await (await app.request(ROUTES.system.trash)).json());
    expect(initial).toMatchObject({
      providerId: PROVIDER_ID,
      revision: 0,
      enabled: false,
      strategy: "native",
    });

    const response = await app.request(ROUTES.system.trash, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ ...initial, enabled: true, rulesConfirmed: true }),
    });
    expect(response.status).toBe(200);
    expect(TrashSettings.parse(await response.json())).toMatchObject({
      revision: 1,
      enabled: true,
    });
  });

  it("rejects non-admin access", async () => {
    expect((await buildApp(false).request(ROUTES.system.trash)).status).toBe(403);
  });
});
