import type { StorageProvider } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { registerTokenRoutes } from "./routes.js";
import { createTokenService } from "./service.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
};

function notImplemented(): never {
  throw new Error("not implemented in this fake");
}

const FAKE_STORAGE: StorageProvider = {
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
};

async function buildApp(clock: () => Date = () => new Date("2026-01-01T00:00:00.000Z")) {
  const repos = createMemoryRepos();
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo:8080" });
  const account = await repos.accounts.create({ displayName: "Alice" });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });

  const service = createTokenService({
    apiTokens: repos.apiTokens,
    identities: repos.identities,
    clock,
    generateToken: () => "fdr_fixed",
  });

  const principal: Principal = {
    accountId: account.id,
    identityId: identity.id,
    username: "alice",
    storage: FAKE_STORAGE,
    isAdmin: false,
  };

  const app = createApp({
    config: loadConfig(REQUIRED_ENV),
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
    } as never,
    version: "1.0.0",
    startedAt: new Date(0),
    connectionStatus: async () => ({
      required: false,
      providers: [{ type: "sftpgo", host: "sftpgo:8080" }],
    }),
    principalResolver: async () => principal,
    registerRoutes: (groups) => {
      registerTokenRoutes(groups, { service });
    },
  });

  return { app, account, identity, service, repos, principal };
}

describe("token routes: GET /account/tokens", () => {
  it("lists no tokens for a fresh account", async () => {
    const { app } = await buildApp();

    const res = await app.request("/api/v1/account/tokens");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("lists a previously created token without its secret", async () => {
    const { app, account, service } = await buildApp();
    await service.create(account.id, { name: "Claude" });

    const res = await app.request("/api/v1/account/tokens");
    const body = (await res.json()) as { items: { name: string }[] };

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.name).toBe("Claude");
    expect(body.items[0]).not.toHaveProperty("token");
  });
});

describe("token routes: POST /account/tokens", () => {
  it("creates a token and returns it once, plus its summary", async () => {
    const { app, identity } = await buildApp();

    const res = await app.request("/api/v1/account/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ name: "Claude" }),
    });
    const body = (await res.json()) as { token: string; item: { identityId: string } };

    expect(res.status).toBe(201);
    expect(body.token).toBe("fdr_fixed");
    expect(body.item.identityId).toBe(identity.id);
  });

  it("the created token then shows up in the list", async () => {
    const { app } = await buildApp();
    await app.request("/api/v1/account/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ name: "Claude" }),
    });

    const res = await app.request("/api/v1/account/tokens");
    const body = (await res.json()) as { items: { name: string }[] };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.name).toBe("Claude");
  });

  it("rejects an invalid body", async () => {
    const { app } = await buildApp();

    const res = await app.request("/api/v1/account/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ name: "" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const { app } = await buildApp();

    const res = await app.request("/api/v1/account/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  it("rejects an identityId that does not belong to the account", async () => {
    const { app } = await buildApp();

    const res = await app.request("/api/v1/account/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({
        name: "Claude",
        identityId: "00000000-0000-0000-0000-000000000000",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects a non-canonical identityId before service access", async () => {
    const { app, service } = await buildApp();
    const create = vi.spyOn(service, "create");

    const res = await app.request("/api/v1/account/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({
        name: "Claude",
        identityId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
      }),
    });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("token routes: DELETE /account/tokens/:id", () => {
  it("revokes a token belonging to the account", async () => {
    const { app, account, service } = await buildApp();
    const created = await service.create(account.id, { name: "Claude" });

    const res = await app.request(`/api/v1/account/tokens/${created.item.id}`, {
      method: "DELETE",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(200);
    const list = await app.request("/api/v1/account/tokens");
    expect((await list.json()) as { items: unknown[] }).toEqual({ items: [] });
  });

  it("is a no-op for an id that does not exist", async () => {
    const { app } = await buildApp();

    const res = await app.request("/api/v1/account/tokens/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(200);
  });
});

it("defaults new tokens to the active login and persists normalized per-token permissions", async () => {
  const { app, account, repos, principal } = await buildApp();
  const provider = await repos.providers.ensure({
    type: "webdav",
    baseUrl: "https://other.invalid",
  });
  const second = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  Object.assign(principal, { identityId: second.id });
  const response = await app.request("/api/v1/account/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
    body: JSON.stringify({
      name: "Scoped",
      access: { mode: "organize", paths: ["/docs/./", "/docs"] },
    }),
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    item: { identityId: second.id, access: { mode: "organize", paths: ["/docs"] } },
  });
});

it("rejects paths that cannot be represented by storage before creating a token", async () => {
  const { app } = await buildApp();
  for (const path of ["relative", "/bad\0path", `/${"a".repeat(256)}`]) {
    const response = await app.request("/api/v1/account/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ name: "Bad", access: { mode: "full", paths: [path] } }),
    });
    expect(response.status).toBe(400);
  }
});

it("rejects malformed token ids before persistence", async () => {
  const { app, service } = await buildApp();
  const revoke = vi.spyOn(service, "revoke");
  const response = await app.request("/api/v1/account/tokens/not-a-uuid", {
    method: "DELETE",
    headers: { "x-requested-with": "fdrive" },
  });
  expect(response.status).toBe(400);
  expect(revoke).not.toHaveBeenCalled();
});
