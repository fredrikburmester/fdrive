import { rmSync } from "node:fs";
import { AdminProvider, AdminProvidersResponse, ProvidersResponse } from "@fdrive/contracts";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { localModuleFixture } from "../local/test-fixtures/index.ts";
import { fakeStorageProvider } from "../scoping/test-fixtures/index.ts";
import { registerProviderRoutes } from "./routes.js";
import {
  memoryProviderService,
  seedLocalProvider,
  seedProviderRow,
} from "./test-fixtures/index.ts";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
};

const FAKE_STORAGE = fakeStorageProvider();

function buildApp(opts: { isAdmin: boolean }) {
  const config = loadConfig(REQUIRED_ENV);
  const repos = createMemoryRepos();
  // A deployment with a files folder, so its pinned row resolves.
  const local = localModuleFixture(repos);
  const service = memoryProviderService(repos, {
    clock: () => new Date("2026-09-10T00:00:00Z"),
    modules: { local: local.module },
  });
  const principal: Principal = {
    accountId: "account-1",
    identityId: "identity-1",
    username: "alice",
    storage: FAKE_STORAGE,
    isAdmin: opts.isAdmin,
  };
  const app = createApp({
    config,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    } as never,
    version: "test",
    startedAt: new Date(0),
    principalResolver: async () => principal,
    connectionStatus: async () => ({ required: false, providers: [] }),
    registerRoutes: (groups) => registerProviderRoutes(groups, { service }),
  });
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { app, repos, service, call, local };
}

describe("GET /providers", () => {
  it("lists enabled providers with their credential forms and nothing else", async () => {
    const h = buildApp({ isAdmin: false });
    const local = await seedLocalProvider(h.repos);
    await seedProviderRow(h.repos, "http://off:8080", { enabled: false });
    // A WebDAV row from before the files folder was the only storage.
    const retired = await h.repos.providers.ensure({ type: "webdav", baseUrl: "http://a:8080" });
    expect(retired.enabled).toBe(true);
    const res = await h.call("/api/v1/providers");
    expect(res.status).toBe(200);
    const body = ProvidersResponse.parse(await res.json());
    expect(body.providers.map((provider) => provider.id)).toEqual([local.id]);
    // No admin-set label and no host: the page names the product instead.
    expect(body.providers[0]).toMatchObject({ type: "local", label: "" });
    expect(body.providers[0]?.credentialFields.map((field) => field.name)).toEqual([
      "username",
      "password",
    ]);
    expect(body.providers[0]?.capabilities).toMatchObject({ index: true, shares: true });
    expect(JSON.stringify(body)).not.toContain("a:8080");
  });
});

describe("/admin/providers", () => {
  it("requires an admin", async () => {
    const h = buildApp({ isAdmin: false });
    const row = await seedLocalProvider(h.repos);
    expect((await h.call("/api/v1/admin/providers")).status).toBe(403);
    expect(
      (
        await h.call(`/api/v1/admin/providers/${row.id}`, {
          method: "PATCH",
          body: { label: "x" },
        })
      ).status,
    ).toBe(403);
  });

  it("refuses renames by ordinary users and rejects blank or overlong names", async () => {
    const ordinary = buildApp({ isAdmin: false });
    const row = await seedLocalProvider(ordinary.repos);
    expect(
      (
        await ordinary.call(`/api/v1/admin/providers/${row.id}`, {
          method: "PATCH",
          body: { label: "Home storage" },
        })
      ).status,
    ).toBe(403);
    expect((await ordinary.repos.providers.get(row.id))?.label).toBe("");
    const admin = buildApp({ isAdmin: true });
    const pinned = await seedLocalProvider(admin.repos);
    const other = await seedProviderRow(admin.repos, "http://other:8080", {
      label: "Home storage",
    });
    for (const label of ["", "   ", "x".repeat(121)]) {
      expect(
        (
          await admin.call(`/api/v1/admin/providers/${pinned.id}`, {
            method: "PATCH",
            body: { label },
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await admin.call(`/api/v1/admin/providers/${pinned.id}`, {
          method: "PATCH",
          body: { label: "  Home storage  " },
        })
      ).status,
    ).toBe(200);
    expect(await admin.repos.providers.get(pinned.id)).toEqual({
      ...pinned,
      label: "Home storage",
    });
    expect(await admin.repos.providers.get(other.id)).toEqual(other);
    const visible = ProvidersResponse.parse(await (await admin.call("/api/v1/providers")).json());
    expect(visible.providers.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: pinned.id, label: "Home storage" },
      { id: other.id, label: "Home storage" },
    ]);
  });

  it("lists the storage with a fresh probe and renames it", async () => {
    const h = buildApp({ isAdmin: true });
    const row = await seedLocalProvider(h.repos);
    await h.repos.providers.ensure({ type: "webdav", baseUrl: "http://a:8080" });
    const list = await h.call("/api/v1/admin/providers");
    expect(list.status).toBe(200);
    const body = AdminProvidersResponse.parse(await list.json());
    // Rows of a type the build no longer has are not storage.
    expect(body).toEqual({
      providers: [
        expect.objectContaining({
          id: row.id,
          type: "local",
          label: "Local folder",
          baseUrl: "",
          managedByEnv: true,
          reachable: true,
          checkedAt: "2026-09-10T00:00:00.000Z",
        }),
      ],
    });

    const renamed = await h.call(`/api/v1/admin/providers/${row.id}`, {
      method: "PATCH",
      body: { label: "Family files" },
    });
    expect(renamed.status).toBe(200);
    expect(AdminProvider.parse(await renamed.json())).toMatchObject({
      id: row.id,
      label: "Family files",
      reachable: true,
    });

    rmSync(h.local.root, { recursive: true, force: true });
    const gone = AdminProvidersResponse.parse(
      await (await h.call("/api/v1/admin/providers")).json(),
    );
    expect(gone.providers[0]?.reachable).toBe(false);
  });

  it("has no routes to add, remove or probe storage", async () => {
    const h = buildApp({ isAdmin: true });
    const row = await seedLocalProvider(h.repos);
    for (const [method, path] of [
      ["POST", "/api/v1/admin/providers"],
      ["POST", "/api/v1/admin/providers/test"],
      ["POST", `/api/v1/admin/providers/${row.id}/test`],
      ["DELETE", `/api/v1/admin/providers/${row.id}`],
    ] as const) {
      const response = await h.call(path, {
        method,
        body: { type: "webdav", label: "x", baseUrl: "http://a" },
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(await h.repos.providers.list()).toEqual([row]);
  });

  it.each([
    ["invalid update id", "/nope", { label: "x" }, 400],
    ["unknown provider", "/00000000-0000-4000-8000-000000000000", { label: "x" }, 404],
    ["retired provider", "/:retired", { label: "x" }, 404],
    ["unknown patch field", "/:id", { label: "x", nope: "x" }, 400],
    ["an address", "/:id", { label: "x", baseUrl: "http://b" }, 400],
    ["enabling or disabling", "/:id", { label: "x", enabled: false }, 400],
    ["configuration", "/:id", { label: "x", config: {} }, 400],
    ["no label", "/:id", {}, 400],
  ] as const)("rejects %s", async (_name, path, body, status) => {
    const h = buildApp({ isAdmin: true });
    const row = await seedLocalProvider(h.repos);
    const retired = await h.repos.providers.ensure({ type: "s3", baseUrl: "http://s3/bucket" });
    const before = await h.repos.providers.list();
    const response = await h.call(
      `/api/v1/admin/providers${path.replace(":id", row.id).replace(":retired", retired.id)}`,
      { method: "PATCH", body },
    );
    expect(response.status).toBe(status);
    expect(await h.repos.providers.list()).toEqual(before);
  });

  it("treats an unparsable JSON body as a bad request", async () => {
    const h = buildApp({ isAdmin: true });
    const row = await seedLocalProvider(h.repos);
    const res = await h.app.request(`/api/v1/admin/providers/${row.id}`, {
      method: "PATCH",
      headers: { "x-requested-with": "fdrive", "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
