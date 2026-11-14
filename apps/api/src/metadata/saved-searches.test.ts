import type { SavedSearch } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import type { Logger } from "pino";
import { expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { registerSavedSearchRoutes } from "./saved-searches.js";

const ALICE = "00000000-0000-4000-8000-000000000001";
const BOB = "00000000-0000-4000-8000-000000000002";

function harness() {
  const repos = createMemoryRepos();
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/fdrive",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    }),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    version: "1.0.0",
    startedAt: new Date(0),
    principalResolver: async (c) => ({
      accountId: c.req.header("x-account") ?? ALICE,
      identityId: "00000000-0000-4000-8000-0000000000a1",
      username: "alice",
      storage: {} as StorageProvider,
      isAdmin: false,
    }),
    registerRoutes: (groups) =>
      registerSavedSearchRoutes(groups, { savedSearches: repos.savedSearches }),
  });
  function call(method: string, path: string, account = ALICE, body?: unknown) {
    return app.request(`/api/v1/saved-searches${path}`, {
      method,
      headers: { "x-requested-with": "fdrive", "x-account": account },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function names(account = ALICE) {
    const body = (await (await call("GET", "", account)).json()) as { searches: SavedSearch[] };
    return body.searches.map((search) => search.name);
  }
  return { call, names };
}

it("saves, lists and removes searches for the caller's account only", async () => {
  const { call, names } = harness();
  const created = await call("POST", "", ALICE, {
    name: "Invoices",
    query: "invoice",
    type: "documents",
    folder: "/Work/../Work/2026/",
  });
  expect(created.status).toBe(201);
  const search = (await created.json()) as SavedSearch;
  expect(search).toEqual({
    id: expect.any(String),
    name: "Invoices",
    query: "invoice",
    type: "documents",
    folder: "/Work/2026",
  });
  await call("POST", "", ALICE, { name: "All", query: "beach", type: "any", folder: null });

  expect(await names()).toEqual(["Invoices", "All"]);
  expect(await names(BOB)).toEqual([]);

  expect((await call("DELETE", `/${search.id}`, BOB)).status).toBe(200);
  expect(await names()).toEqual(["Invoices", "All"]);
  expect(await (await call("DELETE", `/${search.id}`)).json()).toEqual({ ok: true });
  expect(await names()).toEqual(["All"]);
});

it("refuses an empty name, an unknown type and a folder that is not a path", async () => {
  const { call } = harness();
  const base = { name: "Saved", query: "q", type: "any", folder: null };
  expect((await call("POST", "", ALICE, { ...base, name: "" })).status).toBe(400);
  expect((await call("POST", "", ALICE, { ...base, type: "fonts" })).status).toBe(400);
  expect((await call("POST", "", ALICE, { ...base, folder: "/a\u0000b" })).status).toBe(400);
});
