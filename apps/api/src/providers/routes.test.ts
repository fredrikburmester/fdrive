import { AdminProvider, AdminProvidersResponse, ProvidersResponse } from "@fdrive/contracts";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createFakeWebdavServer } from "@fdrive/webdav";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { fakeStorageProvider } from "../scoping/test-fixtures/index.ts";
import { registerProviderRoutes } from "./routes.js";
import type { ProviderService } from "./service.js";
import {
  memoryProviderService,
  probeFetch,
  seedSftpgoProvider,
  seedWebdavProvider,
} from "./test-fixtures/index.ts";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
};

const FAKE_STORAGE = fakeStorageProvider();

function buildApp(opts: { isAdmin: boolean; reachable?: boolean; service?: ProviderService }) {
  const config = loadConfig(REQUIRED_ENV);
  const repos = createMemoryRepos();
  const service =
    opts.service ??
    memoryProviderService(repos, {
      fetch: probeFetch(opts.reachable ?? true),
      clock: () => new Date("2026-09-10T00:00:00Z"),
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
  return { app, repos, service, call };
}

describe("GET /providers", () => {
  it("lists enabled providers with their credential forms and nothing else", async () => {
    const h = buildApp({ isAdmin: false });
    await seedSftpgoProvider(h.repos, "http://a:8080");
    await seedSftpgoProvider(h.repos, "http://b:8080", { enabled: false });
    const res = await h.call("/api/v1/providers");
    expect(res.status).toBe(200);
    const body = ProvidersResponse.parse(await res.json());
    expect(body.providers).toHaveLength(1);
    // No admin-set label and no host: the page names the product instead.
    expect(body.providers[0]).toMatchObject({ type: "sftpgo", label: "" });
    expect(body.providers[0]?.credentialFields.map((field) => field.name)).toEqual([
      "username",
      "password",
      "otp",
    ]);
    expect(JSON.stringify(body)).not.toContain("a:8080");
  });
});

describe("/admin/providers", () => {
  it("requires an admin", async () => {
    const h = buildApp({ isAdmin: false });
    expect((await h.call("/api/v1/admin/providers")).status).toBe(403);
    expect(
      (
        await h.call("/api/v1/admin/providers", {
          method: "POST",
          body: { type: "sftpgo", label: "x", baseUrl: "http://a" },
        })
      ).status,
    ).toBe(403);
  });

  it("lists rows and types, creates after a probe, updates, tests and deletes", async () => {
    const h = buildApp({ isAdmin: true });
    const created = await h.call("/api/v1/admin/providers", {
      method: "POST",
      body: {
        type: "sftpgo",
        label: "Home",
        baseUrl: "http://a:8080",
        config: { homeTemplate: "sftpgo:/{username}" },
      },
    });
    expect(created.status).toBe(200);
    const row = AdminProvider.parse(await created.json());
    expect(row).toMatchObject({ label: "Home", baseUrl: "http://a:8080", enabled: true });

    const list = await h.call("/api/v1/admin/providers");
    const body = AdminProvidersResponse.parse(await list.json());
    expect(body.providers.map((provider) => provider.id)).toEqual([row.id]);
    expect(body.types.map((type) => type.type)).toEqual(["sftpgo", "webdav"]);

    const updated = await h.call(`/api/v1/admin/providers/${row.id}`, {
      method: "PATCH",
      body: { label: "Renamed", enabled: false, config: { homeTemplate: "data:/{username}" } },
    });
    expect(updated.status).toBe(200);
    expect(AdminProvider.parse(await updated.json())).toMatchObject({
      label: "Renamed",
      enabled: false,
      config: { homeTemplate: "data:/{username}" },
    });

    const moved = await h.call(`/api/v1/admin/providers/${row.id}`, {
      method: "PATCH",
      body: { baseUrl: "http://b:8080" },
    });
    expect(moved.status).toBe(200);
    expect(AdminProvider.parse(await moved.json()).baseUrl).toBe("http://b:8080");

    expect(
      (await h.call(`/api/v1/admin/providers/${row.id}/test`, { method: "POST" })).status,
    ).toBe(200);
    const candidate = await h.call("/api/v1/admin/providers/test", {
      method: "POST",
      body: { type: "sftpgo", baseUrl: "http://c:8080" },
    });
    expect(await candidate.json()).toEqual({ ok: true, detail: "SFTPGo is reachable" });

    const deleted = await h.call(`/api/v1/admin/providers/${row.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(await h.repos.providers.get(row.id)).toBeNull();
  });

  it.each([
    ["incomplete create", "POST", "", { type: "sftpgo" }, 400],
    [
      "invalid create template",
      "POST",
      "",
      {
        type: "sftpgo",
        label: "x",
        baseUrl: "http://a",
        config: { homeTemplate: "no-colon" },
      },
      400,
    ],
    ["incomplete probe", "POST", "/test", { type: "sftpgo" }, 400],
    ["invalid probe id", "POST", "/nope/test", undefined, 400],
    ["invalid update id", "PATCH", "/nope", { label: "x" }, 400],
    ["unknown provider", "PATCH", "/00000000-0000-4000-8000-000000000000", { label: "x" }, 404],
    ["unknown patch field", "PATCH", "/00000000-0000-4000-8000-000000000000", { nope: "x" }, 400],
    [
      "invalid update template",
      "PATCH",
      "/:id",
      { config: { homeTemplate: "still-no-colon" } },
      400,
    ],
  ] as const)("rejects %s", async (_name, method, path, body, status) => {
    const h = buildApp({ isAdmin: true });
    const row = await seedSftpgoProvider(h.repos, "http://a:8080");
    const response = await h.call(`/api/v1/admin/providers${path.replace(":id", row.id)}`, {
      method,
      body,
    });
    expect(response.status).toBe(status);
    expect(await h.repos.providers.list()).toEqual([row]);
  });

  it("treats an unparsable JSON body as a bad request on every writing route", async () => {
    const h = buildApp({ isAdmin: true });
    const row = await seedSftpgoProvider(h.repos, "http://a:8080");
    for (const [path, method] of [
      ["/api/v1/admin/providers", "POST"],
      ["/api/v1/admin/providers/test", "POST"],
      [`/api/v1/admin/providers/${row.id}`, "PATCH"],
    ] as const) {
      const res = await h.app.request(path, {
        method,
        headers: { "x-requested-with": "fdrive", "content-type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    }
  });

  it("refuses to create or re-address an unreachable provider", async () => {
    const h = buildApp({ isAdmin: true, reachable: false });
    const created = await h.call("/api/v1/admin/providers", {
      method: "POST",
      body: { type: "sftpgo", label: "x", baseUrl: "http://a:8080" },
    });
    expect(created.status).toBe(400);
    expect(await created.json()).toMatchObject({
      error: { kind: "bad_request", message: expect.stringContaining("not reachable") },
    });
    expect(await h.repos.providers.list()).toEqual([]);
    const row = await seedSftpgoProvider(h.repos, "http://a:8080");
    const moved = await h.call(`/api/v1/admin/providers/${row.id}`, {
      method: "PATCH",
      body: { baseUrl: "http://b:8080" },
    });
    expect(moved.status).toBe(400);
    expect((await h.repos.providers.get(row.id))?.baseUrl).toBe("http://a:8080");
  });
});

describe("/admin/providers with a WebDAV type", () => {
  function davHarness(isAdmin: boolean) {
    const dav = createFakeWebdavServer({ users: [], origin: "http://dav.test", prefix: "/dav" });
    const repos = createMemoryRepos();
    const service = memoryProviderService(repos, {
      fetch: dav.fetch,
      clock: () => new Date("2026-09-10T00:00:00Z"),
    });
    const built = buildApp({ isAdmin, service });
    return { dav, repos, app: built.app, call: built.call };
  }

  it("probes with OPTIONS, creates the row and advertises its form and capabilities", async () => {
    const h = davHarness(true);
    const created = await h.call("/api/v1/admin/providers", {
      method: "POST",
      body: { type: "webdav", label: "Nextcloud", baseUrl: "http://dav.test/dav" },
    });
    expect(created.status).toBe(200);
    expect(AdminProvider.parse(await created.json())).toMatchObject({
      type: "webdav",
      label: "Nextcloud",
      config: {},
      enabled: true,
      managedByEnv: false,
    });
    expect(h.dav.requests[0]).toMatchObject({ method: "OPTIONS", url: "http://dav.test/dav/" });

    const list = AdminProvidersResponse.parse(
      await (await h.call("/api/v1/admin/providers")).json(),
    );
    expect(list.providers[0]).toMatchObject({ type: "webdav", reachable: true });
    const type = list.types.find((entry) => entry.type === "webdav");
    expect(type).toMatchObject({
      label: "WebDAV",
      configFields: [],
      capabilities: {
        zip: false,
        setModifiedAt: false,
        atomicMove: true,
        trash: false,
        shares: false,
        office: false,
        index: false,
        scopeMapping: false,
      },
    });
    expect(type?.credentialFields.map((field) => field.name)).toEqual(["username", "password"]);

    const candidate = await h.call("/api/v1/admin/providers/test", {
      method: "POST",
      body: { type: "webdav", baseUrl: "http://dav.test/dav" },
    });
    expect(await candidate.json()).toEqual({
      ok: true,
      detail: "WebDAV is reachable (class 1, 2)",
    });
    const unreachable = await h.call("/api/v1/admin/providers/test", {
      method: "POST",
      body: { type: "webdav", baseUrl: "http://elsewhere.test/" },
    });
    expect(((await unreachable.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("refuses configuration the type does not declare", async () => {
    const h = davHarness(true);
    const created = await h.call("/api/v1/admin/providers", {
      method: "POST",
      body: {
        type: "webdav",
        label: "x",
        baseUrl: "http://dav.test/dav",
        config: { homeTemplate: "sftpgo:/{username}" },
      },
    });
    expect(created.status).toBe(400);
  });

  it("lists a WebDAV row publicly with only its credential form", async () => {
    const h = davHarness(false);
    await seedWebdavProvider(h.repos, "http://dav.test/dav", { label: "Team drive" });
    const res = await h.call("/api/v1/providers");
    const body = ProvidersResponse.parse(await res.json());
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({ type: "webdav", label: "Team drive" });
    expect(body.providers[0]?.credentialFields.map((field) => field.name)).toEqual([
      "username",
      "password",
    ]);
    expect(JSON.stringify(body)).not.toContain("dav.test");
  });
});
