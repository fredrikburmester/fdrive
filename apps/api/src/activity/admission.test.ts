import { randomUUID } from "node:crypto";
import type { ClientActivityRequest } from "@fdrive/contracts";
import { StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { AppVariables } from "../app.js";
import type { PrincipalVariables } from "../auth/principal.js";
import { COOKIE_NAME } from "../auth/sessions.js";
import { ApiHttpError } from "../errors.js";
import { type ActivityAdmissionDeps, createActivityAdmission } from "./admission.js";

/**
 * One admission handler with a mutable gesture, so each test below exercises a
 * single guard and a failure names that guard instead of the whole pipeline.
 */
function harness() {
  const owner = randomUUID();
  const identityId = randomUUID();
  const now = new Date();
  const storage = createMemoryStorage();
  const deps = {
    identities: { get: vi.fn(async () => ({ accountId: owner })) },
    storageFactory: async () => storage,
    clock: () => now,
    secret: "server-secret",
    reads: { record: vi.fn(async (_input: unknown) => "window") },
    repo: { clientEvent: vi.fn(async () => ({ id: "copy" })) },
    shares: { getOwned: vi.fn(async () => ({ paths: ["/a"] }) as { paths: string[] } | null) },
  };
  const admit = createActivityAdmission(deps as unknown as ActivityAdmissionDeps);
  let input: ClientActivityRequest = {
    identityId,
    requestId: randomUUID(),
    at: now.toISOString(),
    action: "file.open",
    path: "/a",
  };
  const app = new Hono<{ Variables: AppVariables & PrincipalVariables }>();
  app.use("*", async (c, next) => {
    c.set("principal", { accountId: owner, identityId, storage, username: "a", isAdmin: false });
    await next();
  });
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof ApiHttpError ? 403 : 500),
  );
  app.get("/", async (c) => c.json({ id: await admit(c, input) }));
  return {
    now,
    storage,
    deps,
    setInput: (next: ClientActivityRequest) => {
      input = next;
    },
    input: () => input,
    request: () => app.request("/", { headers: { cookie: `${COOKIE_NAME}=private-session` } }),
  };
}

it("records a linked readable file gesture without the raw session cookie", async () => {
  const h = harness();
  await h.storage.upload("/a", new Uint8Array([1]));

  expect(await (await h.request()).json()).toEqual({ id: "window" });
  expect(h.deps.reads.record).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: expect.any(String),
      identityId: expect.any(String),
      source: "web",
      evidence: "client_reported",
      outcome: "unknown",
      contextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  );
  expect(JSON.stringify(h.deps.reads.record.mock.calls)).not.toContain("private-session");
});

it("classifies a directory path as a dir gesture", async () => {
  const h = harness();
  await h.storage.mkdir("/d");
  h.setInput({ ...h.input(), path: "/d" });

  await h.request();

  expect(h.deps.reads.record.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "dir" });
});

it("scopes a copied link to a share the identity owns and covers the path", async () => {
  const h = harness();
  await h.storage.upload("/a", new Uint8Array([1]));
  h.setInput({ ...h.input(), action: "share.copy_link", shareId: randomUUID() });

  expect(await (await h.request()).json()).toEqual({ id: "copy" });

  h.deps.shares.getOwned.mockResolvedValueOnce(null);
  expect((await h.request()).status).toBe(403);

  h.deps.shares.getOwned.mockResolvedValueOnce({ paths: ["/other"] });
  expect((await h.request()).status).toBe(403);

  h.setInput({ ...h.input(), shareId: undefined } as unknown as ClientActivityRequest);
  expect((await h.request()).status).toBe(403);
});

it("rejects a gesture whose identity belongs to another account", async () => {
  const h = harness();
  h.deps.identities.get.mockResolvedValueOnce({ accountId: randomUUID() });

  expect((await h.request()).status).toBe(403);
});

it("rejects a gesture timestamp outside the freshness window", async () => {
  const h = harness();
  for (const at of [new Date(h.now.getTime() - 700_000), new Date(h.now.getTime() + 70_000)]) {
    h.setInput({ ...h.input(), at: at.toISOString() });
    expect((await h.request()).status).toBe(403);
  }
});

it("rejects a gesture whose path fails the live readability proof", async () => {
  const h = harness();
  vi.spyOn(h.storage, "download").mockRejectedValueOnce(new StorageError("forbidden", "denied"));

  expect((await h.request()).status).toBe(403);
});
