import { AdminProvider, AdminProvidersResponse, ProvidersResponse } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { registerProviderRoutes } from "./routes.js";
import { createProviderService, type ProviderService } from "./service.js";
import { seedSftpgoProvider } from "./test-fixtures/index.ts";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
};

function notImplemented(): never {
  throw new Error("not implemented in this fake");
}

const FAKE_STORAGE = {
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
} as StorageProvider;

function probeFetch(reachable = true): typeof globalThis.fetch {
  return vi.fn(async (url: unknown) => {
    if (!reachable) return new Response("boom", { status: 500 });
    return String(url).endsWith("/healthz")
      ? new Response("ok", { status: 200 })
      : new Response("unauthorized", { status: 401 });
  }) as unknown as typeof globalThis.fetch;
}

function buildApp(opts: { isAdmin: boolean; reachable?: boolean; service?: ProviderService }) {
  const config = loadConfig(REQUIRED_ENV);
  const repos = createMemoryRepos();
  const service =
    opts.service ??
    createProviderService({
      repos,
      fetch: probeFetch(opts.reachable ?? true),
      clock: () => new Date("2026-09-10T00:00:00Z"),
      environment: { sftpgoUrl: undefined, homeTemplate: "sftpgo:/{username}", indexRootCount: 0 },
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
    expect(body.providers[0]).toMatchObject({ type: "sftpgo", label: "a:8080" });
    expect(body.providers[0]?.credentialFields.map((field) => field.name)).toEqual([
      "username",
      "password",
      "otp",
    ]);
    expect(JSON.stringify(body)).not.toContain("http://a:8080");
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
    expect(body.types.map((type) => type.type)).toEqual(["sftpgo"]);

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

  it("rejects malformed bodies, bad ids, invalid home templates and unknown rows", async () => {
    const h = buildApp({ isAdmin: true });
    expect(
      (await h.call("/api/v1/admin/providers", { method: "POST", body: { type: "sftpgo" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.call("/api/v1/admin/providers", {
          method: "POST",
          body: {
            type: "sftpgo",
            label: "x",
            baseUrl: "http://a",
            config: { homeTemplate: "no-colon" },
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.call("/api/v1/admin/providers/test", { method: "POST", body: { type: "sftpgo" } }))
        .status,
    ).toBe(400);
    expect((await h.call("/api/v1/admin/providers/nope/test", { method: "POST" })).status).toBe(
      400,
    );
    expect(
      (await h.call("/api/v1/admin/providers/nope", { method: "PATCH", body: { label: "x" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.call("/api/v1/admin/providers/00000000-0000-4000-8000-000000000000", {
          method: "PATCH",
          body: { label: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.call("/api/v1/admin/providers/00000000-0000-4000-8000-000000000000", {
          method: "PATCH",
          body: { nope: "x" },
        })
      ).status,
    ).toBe(400);
    const row = await seedSftpgoProvider(h.repos, "http://a:8080");
    expect(
      (
        await h.call(`/api/v1/admin/providers/${row.id}`, {
          method: "PATCH",
          body: { config: { homeTemplate: "still-no-colon" } },
        })
      ).status,
    ).toBe(400);
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
