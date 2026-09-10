import { type FeatureConfiguration, ROUTES, WORKER_TOKEN_HEADER } from "@fdrive/contracts";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { registerFeatureAdmission } from "./admission.js";
import { registerFeatureRoutes } from "./routes.js";
import { DISABLED_FEATURES, type FeatureService } from "./service.js";

function fixture({
  admin = true,
  workerToken = "worker-secret",
  setupRequired = false,
}: {
  admin?: boolean;
  workerToken?: string;
  setupRequired?: boolean;
} = {}) {
  let configuration: FeatureConfiguration = {
    version: 1,
    revision: 0,
    values: DISABLED_FEATURES,
    walkthroughComplete: false,
  };
  const service: FeatureService = {
    configuration: async () => configuration,
    status: async () => ({ configuration, source: "settings", statuses: [], roots: [] }),
    update: vi.fn(async (input) => {
      configuration = { version: 1, ...input, revision: input.revision + 1 };
      return configuration;
    }),
    enabled: async (id) => configuration.values[id],
  };
  const principal = {
    accountId: "a",
    identityId: "i",
    username: "alice",
    isAdmin: admin,
    storage: {},
  } as Principal;
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/fdrive",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    }),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    version: "1",
    startedAt: new Date(),
    principalResolver: async () => principal,
    connectionStatus: async () => ({
      required: setupRequired,
      providers: setupRequired ? [] : [{ type: "sftpgo", host: "sftpgo" }],
    }),
    registerRoutes(groups) {
      registerFeatureAdmission(groups.authed, service);
      registerFeatureRoutes(groups, { service, workerToken });
      for (const route of [
        ROUTES.system.ocrRun,
        ROUTES.system.searchReembed,
        ROUTES.system.imageSearchRebuild,
        ROUTES.system.thumbnailsRebuild,
        ROUTES.system.indexerThumbnailsRebuild,
        ROUTES.system.indexerReindex,
        ROUTES.system.indexerClear,
      ])
        groups.authed.post(route.slice("/api/v1".length), (c) => c.json({ ok: true }));
    },
  });
  return { app, service };
}
const headers = { "Content-Type": "application/json", "X-Requested-With": "fdrive" };

describe("feature routes", () => {
  it("protects configuration with admin and CSRF checks", async () => {
    expect((await fixture({ admin: false }).app.request(ROUTES.system.features)).status).toBe(403);
    const { app } = fixture();
    expect((await app.request(ROUTES.system.features)).status).toBe(200);
    expect((await app.request(ROUTES.system.features, { method: "PUT", body: "{}" })).status).toBe(
      403,
    );
  });
  it("validates complete settings and explicit dependencies before saving", async () => {
    const { app, service } = fixture();
    for (const body of [
      "{",
      JSON.stringify({
        revision: 0,
        values: { ...DISABLED_FEATURES, semanticSearch: true },
        walkthroughComplete: false,
      }),
    ]) {
      expect(
        (await app.request(ROUTES.system.features, { method: "PUT", headers, body })).status,
      ).toBe(400);
    }
    expect(service.update).not.toHaveBeenCalled();
    const res = await app.request(ROUTES.system.features, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        revision: 0,
        values: { ...DISABLED_FEATURES, pdfOcr: true },
        walkthroughComplete: false,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configuration: { revision: 1, values: { pdfOcr: true, searchOcr: false } },
    });
  });
  it("serves internal config during setup only with a valid worker credential", async () => {
    const { app } = fixture({ setupRequired: true });
    for (const token of ["", "wrong", "wrong-secret!"]) {
      expect(
        (
          await app.request("/api/v1/internal/features", {
            headers: { [WORKER_TOKEN_HEADER]: token },
          })
        ).status,
      ).toBe(401);
    }
    const response = await app.request("/api/v1/internal/features", {
      headers: { [WORKER_TOKEN_HEADER]: "worker-secret" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ values: DISABLED_FEATURES });
    expect(
      (await fixture({ workerToken: "" }).app.request("/api/v1/internal/features")).status,
    ).toBe(401);
  });
  it("blocks new work while off but permits clearing retained data", async () => {
    const { app, service } = fixture();
    for (const path of [
      ROUTES.system.ocrRun,
      ROUTES.system.searchReembed,
      ROUTES.system.imageSearchRebuild,
      ROUTES.system.thumbnailsRebuild,
      ROUTES.system.indexerThumbnailsRebuild,
      ROUTES.system.indexerReindex,
    ]) {
      expect((await app.request(path, { method: "POST", headers })).status).toBe(409);
    }
    expect(
      (await app.request(ROUTES.system.indexerClear, { method: "POST", headers })).status,
    ).toBe(200);
    await service.update({
      revision: 0,
      walkthroughComplete: true,
      values: {
        ...DISABLED_FEATURES,
        imageSearch: true,
        pdfOcr: true,
        semanticSearch: true,
        textSearch: true,
      },
    });
    expect((await app.request(ROUTES.system.ocrRun, { method: "POST", headers })).status).toBe(200);
    expect(
      (await app.request(ROUTES.system.thumbnailsRebuild, { method: "POST", headers })).status,
    ).toBe(200);
  });
});
