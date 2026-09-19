import { randomUUID } from "node:crypto";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { ActivityEventRecord, ActivityExportsRepo, ActivityRepo } from "@fdrive/db";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { AppVariables } from "../app.js";
import type { Principal, PrincipalVariables } from "../auth/principal.js";
import { COOKIE_NAME } from "../auth/sessions.js";
import { activityCsv, activityExport, registerActivityExports } from "./exports.js";

function fixture() {
  const owner = randomUUID(),
    identityId = randomUUID(),
    fileId = randomUUID(),
    eventId = randomUUID(),
    at = new Date("2026-09-14");
  const event: ActivityEventRecord = {
    id: eventId,
    ownerAccountId: owner,
    identityId,
    ownerSequence: 1,
    schemaVersion: 1,
    actorAccountId: owner,
    fileId,
    class: "action",
    action: "file.upload",
    stage: "outcome",
    outcome: "success",
    source: "web",
    evidence: "server_confirmed",
    operationId: null,
    producerOperationId: null,
    batchId: null,
    parentEventId: null,
    occurredAt: at,
    recordedAt: at,
    sortAt: at,
    lastConfirmedAt: null,
    detectedAt: null,
    before: null,
    after: { path: "/a", size: 1 },
    detail: null,
    errorCode: null,
    count: 1,
    firstAt: null,
    lastAt: null,
    outcomeCounts: null,
    idempotencyKey: "receipt",
  };
  const subject = {
    ownerAccountId: owner,
    eventId,
    identityId,
    fileId,
    role: "primary" as const,
    ordinal: 0,
    path: "/a",
    revisionId: null,
  };
  const snapshot = {
    id: randomUUID(),
    ownerAccountId: owner,
    format: "json" as "json" | "csv",
    filters: {} as Record<string, string>,
    snapshotSequence: 1,
    createdAt: at,
    expiresAt: new Date(at.getTime() + 86_400_000),
    state: "completed" as const,
    rowCount: 0,
    errorCode: null,
  };
  const read = {
    ownerAccountId: owner,
    exportId: snapshot.id,
    windowId: randomUUID(),
    payload: {
      id: randomUUID(),
      ownerAccountId: owner,
      identityId,
      fileId,
      action: "file.open" as const,
      source: "web" as const,
      evidence: "client_reported" as const,
      contextHash: "private",
      generation: 1,
      bucketStart: at.toISOString(),
      firstAt: at.toISOString(),
      lastAt: at.toISOString(),
      path: "/a",
      count: 2,
      outcomeCounts: { unknown: 2 },
      sealedAt: null,
    },
  };
  const edge = {
    id: randomUUID(),
    ownerAccountId: owner,
    eventId,
    sourceIdentityId: identityId,
    targetIdentityId: identityId,
    sourceFileId: fileId,
    targetFileId: randomUUID(),
    kind: "copy" as const,
    evidence: "server_confirmed" as const,
  };
  const revision = {
    id: randomUUID(),
    ownerAccountId: owner,
    eventId,
    identityId,
    fileId,
    previousRevisionId: null,
    providerVersion: null,
    size: 1,
    sha256: null,
  };
  const repo = {
    boundary: vi.fn(async () => ({ historyStartsAt: at, retainedFrom: null })),
    list: vi.fn(async (_owner: string, _filters: unknown) => [event]),
    subjectPage: vi.fn(async (_owner: string, _id: string, _ordinal: number) => [subject]),
  };
  const exports = {
    create: vi.fn(async (_owner: string, _format: string, _filters: unknown) => snapshot),
    get: vi.fn(async (accountId: string, id: string) =>
      accountId === owner && id === snapshot.id ? snapshot : null,
    ),
    reads: vi.fn(async (_owner: string, _id: string, _cursor?: string) => [read]),
    lineage: vi.fn(async (_owner: string, _seq: number, _cursor?: string, _filters?: unknown) => [
      { edge },
    ]),
    revisions: vi.fn(async (_owner: string, _seq: number, _cursor?: string, _filters?: unknown) => [
      { revision },
    ]),
  };
  const stream = () =>
    activityExport(
      repo as unknown as ActivityRepo,
      exports as ActivityExportsRepo,
      owner,
      snapshot,
    );
  async function text() {
    let body = "";
    for await (const piece of stream()) body += piece;
    return body;
  }
  return {
    repo,
    exports,
    owner,
    identityId,
    fileId,
    event,
    subject,
    snapshot,
    read,
    edge,
    revision,
    stream,
    text,
  };
}
it("exports complete paged subjects, read snapshots, lineage and revisions without private routing fields", async () => {
  const h = fixture();
  h.repo.list
    .mockResolvedValueOnce(Array.from({ length: 100 }, () => h.event))
    .mockResolvedValueOnce([]);
  h.repo.subjectPage
    .mockResolvedValueOnce(Array.from({ length: 100 }, (_, ordinal) => ({ ...h.subject, ordinal })))
    .mockResolvedValueOnce([{ ...h.subject, ordinal: 100 }]);
  h.exports.reads
    .mockResolvedValueOnce(Array.from({ length: 100 }, () => h.read))
    .mockResolvedValueOnce([]);
  h.exports.lineage
    .mockResolvedValueOnce(Array.from({ length: 100 }, () => ({ edge: h.edge })))
    .mockResolvedValueOnce([]);
  h.exports.revisions
    .mockResolvedValueOnce(Array.from({ length: 100 }, () => ({ revision: h.revision })))
    .mockResolvedValueOnce([]);
  const body = await h.text(),
    parsed = JSON.parse(body);
  expect(parsed.events).toHaveLength(200);
  expect(parsed.events[0].subjects).toHaveLength(101);
  expect(parsed.lineage).toHaveLength(100);
  expect(parsed.revisions).toHaveLength(100);
  expect(body).not.toMatch(/ownerAccountId|contextHash|idempotencyKey|private/);
  expect(h.repo.subjectPage).toHaveBeenCalledWith(h.owner, h.event.id, 99);
  expect(h.repo.list.mock.calls.at(-1)?.[1]).toMatchObject({
    snapshotSequence: 1,
    after: { at: h.event.sortAt, id: h.event.id },
  });
  h.snapshot.format = "csv";
  h.repo.subjectPage.mockResolvedValueOnce([]);
  const csv = await h.text();
  expect(csv).toContain('"event"');
  expect(csv).toContain('"read_window"');
  expect(csv).toContain('"lineage"');
  expect(csv).toContain('"revision"');
});
it("applies export filters consistently, includes empty boundaries, and escapes spreadsheet formulas", async () => {
  const h = fixture();
  h.snapshot.filters = {
    identityId: h.identityId,
    action: "file.open",
    source: "web",
    outcome: "unknown",
    q: "a",
    from: "2026-09-01T00:00:00Z",
    to: "2026-10-01T00:00:00Z",
  };
  const body = JSON.parse(await h.text());
  expect(body.events.at(-1).provisional).toBe(true);
  expect(h.exports.lineage.mock.calls[0]?.[3]).toMatchObject({
    action: "file.open",
    source: "web",
    outcome: "unknown",
    identityId: h.identityId,
    q: "a",
  });
  for (const filters of [
    { fileId: randomUUID() },
    { batchId: randomUUID() },
    { identityId: randomUUID() },
    { action: "file.save" },
    { source: "api" },
    { outcome: "success" },
    { q: "missing" },
    { from: "2026-09-15T00:00:00Z" },
    { to: "2026-09-13T00:00:00Z" },
  ]) {
    h.snapshot.filters = filters;
    expect(JSON.parse(await h.text()).events).toHaveLength(1);
  }
  h.snapshot.filters = {};
  h.repo.list.mockResolvedValue([]);
  h.exports.reads.mockResolvedValue([]);
  h.exports.lineage.mockResolvedValue([]);
  h.exports.revisions.mockResolvedValue([]);
  h.repo.boundary.mockResolvedValue(null as never);
  expect(JSON.parse(await h.text())).toMatchObject({
    historyStartsAt: null,
    retainedFrom: null,
    events: [],
    lineage: [],
    revisions: [],
  });
  expect(activityCsv('=HYPERLINK("secret")')).toBe('"\'=HYPERLINK(""secret"")"');
  expect(activityCsv("  +cmd")).toBe('"\'  +cmd"');
  expect(activityCsv(null)).toBe('""');
  expect(activityCsv(4)).toBe('"4"');
  expect(activityCsv({ x: 1 })).toBe('"{""x"":1}"');
});
it("requires a private account session for manifest creation and downloads, with revocation and cancellation", async () => {
  const h = fixture();
  let principal: Principal = {
    accountId: h.owner,
    identityId: h.identityId,
    storage: createMemoryStorage(),
    username: "a",
    isAdmin: false,
  };
  const app = new Hono<{ Variables: AppVariables & PrincipalVariables }>();
  app.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  app.onError((error, c) => c.json({ error: error.message }, 404));
  registerActivityExports(app, {
    repo: h.repo as unknown as ActivityRepo,
    exports: h.exports as ActivityExportsRepo,
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`/activity/exports${path}`, {
      ...init,
      headers: {
        cookie: `${COOKIE_NAME}=session`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  expect(
    (
      await request("", {
        method: "POST",
        body: JSON.stringify({ format: "json", filters: { q: "a" } }),
      })
    ).status,
  ).toBe(202);
  expect(h.exports.create).toHaveBeenCalledWith(h.owner, "json", { q: "a" });
  expect(
    (await request("", { method: "POST", body: JSON.stringify({ format: "csv" }) })).status,
  ).toBe(202);
  expect((await request(`/${h.snapshot.id}`)).status).toBe(200);
  expect((await request("/invalid")).status).toBe(404);
  const response = await request(`/${h.snapshot.id}/download`);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(JSON.parse(await response.text()).events).toHaveLength(2);
  h.snapshot.format = "csv";
  const csv = await request(`/${h.snapshot.id}/download`);
  expect(csv.headers.get("content-type")).toContain("text/csv");
  await csv.body?.cancel();
  principal = { ...principal, accountId: randomUUID() };
  expect((await request(`/${h.snapshot.id}`)).status).toBe(404);
  expect((await request(`/${h.snapshot.id}/download`)).status).toBe(404);
  principal = { ...principal, accountId: h.owner, verifyAuthority: async () => false };
  const expired = await request(`/${h.snapshot.id}/download`);
  await expect(expired.text()).rejects.toThrow("Session expired");
});
