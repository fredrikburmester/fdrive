import { PublicUrlSettings, ROUTES } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { SettingsRepo } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { createPublicUrlService } from "./public-url.js";
import { registerPublicUrlRoutes } from "./public-url-routes.js";

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
      SFTPGO_URL: "http://sftpgo.test",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    }),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    version: "test",
    startedAt: new Date(0),
    principalResolver: async () => principal,
    registerRoutes: (groups) =>
      registerPublicUrlRoutes(groups, { service: createPublicUrlService({ settings }) }),
  });
}

const headers = { "content-type": "application/json", "x-requested-with": "fdrive" };

describe("public URL routes", () => {
  it("reads and updates the server address for an administrator", async () => {
    const app = buildApp(true);
    const initial = PublicUrlSettings.parse(
      await (await app.request(ROUTES.system.publicUrl)).json(),
    );
    expect(initial).toEqual({ revision: 0, url: null });
    const updated = await app.request(ROUTES.system.publicUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ revision: 0, url: "https://drive.example/" }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ revision: 1, url: "https://drive.example" });
    expect(await (await app.request(ROUTES.system.publicUrl)).json()).toEqual({
      revision: 1,
      url: "https://drive.example",
    });
  });

  it("rejects an address that is not a clean origin", async () => {
    const app = buildApp(true);
    const response = await app.request(ROUTES.system.publicUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ revision: 0, url: "https://drive.example/files" }),
    });
    expect(response.status).toBe(400);
  });

  it("reports a stale revision as a conflict", async () => {
    const app = buildApp(true);
    await app.request(ROUTES.system.publicUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ revision: 0, url: "https://drive.example" }),
    });
    const stale = await app.request(ROUTES.system.publicUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ revision: 0, url: null }),
    });
    expect(stale.status).toBe(409);
  });

  it("is admin only", async () => {
    const app = buildApp(false);
    expect((await app.request(ROUTES.system.publicUrl)).status).toBe(403);
    expect(
      (
        await app.request(ROUTES.system.publicUrl, {
          method: "PUT",
          headers,
          body: JSON.stringify({ revision: 0, url: null }),
        })
      ).status,
    ).toBe(403);
  });
});
