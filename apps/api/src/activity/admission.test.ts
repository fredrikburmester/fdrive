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

it("admits only linked readable gestures, scopes copied links, and hashes the session context", async () => {
  const owner = randomUUID(),
    identityId = randomUUID(),
    shareId = randomUUID(),
    now = new Date();
  const storage = createMemoryStorage();
  await storage.upload("/a", new Uint8Array([1]));
  await storage.mkdir("/d");
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
  const request = () => app.request("/", { headers: { cookie: `${COOKIE_NAME}=private-session` } });

  expect(await (await request()).json()).toEqual({ id: "window" });
  expect(deps.reads.record).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: owner,
      identityId,
      source: "web",
      evidence: "client_reported",
      outcome: "unknown",
      contextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  );
  expect(JSON.stringify(deps.reads.record.mock.calls)).not.toContain("private-session");

  input = { ...input, path: "/d" };
  await request();
  expect(deps.reads.record.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "dir" });

  input = { ...input, path: "/a", action: "share.copy_link", shareId };
  expect(await (await request()).json()).toEqual({ id: "copy" });
  deps.shares.getOwned.mockResolvedValueOnce(null);
  expect((await request()).status).toBe(403);
  deps.shares.getOwned.mockResolvedValueOnce({ paths: ["/other"] });
  expect((await request()).status).toBe(403);
  input = { ...input, shareId: undefined } as unknown as ClientActivityRequest;
  expect((await request()).status).toBe(403);

  deps.identities.get.mockResolvedValueOnce({ accountId: randomUUID() });
  expect((await request()).status).toBe(403);
  for (const at of [new Date(now.getTime() - 700_000), new Date(now.getTime() + 70_000)]) {
    input = { ...input, at: at.toISOString() };
    expect((await request()).status).toBe(403);
  }
  input = { ...input, at: now.toISOString(), action: "file.open" };
  vi.spyOn(storage, "download").mockRejectedValueOnce(new StorageError("forbidden", "denied"));
  expect((await request()).status).toBe(403);
});
