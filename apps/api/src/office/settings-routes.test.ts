import { ROUTES, SystemOfficeResponse, WORKER_TOKEN_HEADER } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Identity, SettingsRepo } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { createOfficeSettingsService } from "./settings.js";
import { registerOfficeSettingsRoutes } from "./settings-routes.js";

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

function buildApp(isAdmin: boolean, workerToken = "worker-secret") {
  let stored: unknown | null = null;
  const settings: Pick<SettingsRepo, "get" | "compareAndSet"> = {
    get: async <T>() => stored as T | null,
    compareAndSet: async (_key, expected, value) => {
      if (JSON.stringify(stored) !== JSON.stringify(expected)) return false;
      stored = value;
      return true;
    },
  };
  const service = createOfficeSettingsService({
    settings,
    product: "onlyoffice",
    publicUrl: async () => "https://drive.example",
    probeStatus: async () => "ready",
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
    registerRoutes: (groups) =>
      registerOfficeSettingsRoutes(groups, {
        service,
        workerToken,
        activeProviderId: async () => PROVIDER_ID,
      }),
  });
}

describe("Office settings routes", () => {
  it("returns defaults and updates settings for an administrator", async () => {
    const app = buildApp(true);
    const initial = SystemOfficeResponse.parse(
      await (await app.request(ROUTES.system.office)).json(),
    );
    expect(initial).toMatchObject({
      configuration: { revision: 0, enabled: false },
      product: "onlyoffice",
      status: "off",
      activeProviderId: PROVIDER_ID,
    });
    const response = await app.request(ROUTES.system.office, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({
        ...initial.configuration,
        enabled: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configuration: { revision: 1, enabled: true },
      status: "ready",
    });
  });

  it("requires admin access and valid update data", async () => {
    expect((await buildApp(false).request(ROUTES.system.office)).status).toBe(403);
    const bad = await buildApp(true).request(ROUTES.system.office, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ revision: 0, enabled: true }),
    });
    expect(bad.status).toBe(400);
    const malformed = await buildApp(true).request(ROUTES.system.office, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
  });

  it("exposes only minimal desired state to an authenticated worker", async () => {
    const app = buildApp(true);
    expect((await app.request("/api/v1/internal/office")).status).toBe(401);
    const response = await app.request("/api/v1/internal/office", {
      headers: { [WORKER_TOKEN_HEADER]: "worker-secret" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: 1, revision: 0, enabled: false });
    expect(
      (
        await buildApp(true, "").request("/api/v1/internal/office", {
          headers: { [WORKER_TOKEN_HEADER]: "" },
        })
      ).status,
    ).toBe(401);
  });
});
