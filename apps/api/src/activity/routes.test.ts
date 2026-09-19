import { randomUUID } from "node:crypto";
import type {
  ActivityFileResponse,
  PersonalActivityEvent,
  PersonalActivityResponse,
} from "@fdrive/contracts";
import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type {
  ActivityEventRecord,
  ActivityReadsRepo,
  ActivityRepo,
  IdentityRepo,
} from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { COOKIE_NAME } from "../auth/sessions.js";
import { loadConfig } from "../config.js";
import { createActivityCursors } from "./cursor.js";
import { registerPersonalActivityRoutes, serializeReadWindow } from "./routes.js";

const time = new Date("2026-09-14T10:00:00Z");
const CURSOR_SECRET = "test-secret";

function activityEvent(owner: string, identityId: string): ActivityEventRecord {
  return {
    id: randomUUID(),
    ownerAccountId: owner,
    identityId,
    ownerSequence: 1,
    schemaVersion: 1,
    actorAccountId: owner,
    fileId: randomUUID(),
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
    occurredAt: time,
    recordedAt: time,
    sortAt: time,
    lastConfirmedAt: null,
    detectedAt: null,
    before: null,
    after: { path: "/a.txt", size: 1 },
    detail: null,
    errorCode: null,
    count: 1,
    firstAt: null,
    lastAt: null,
    outcomeCounts: null,
    idempotencyKey: "private-receipt",
  };
}

/**
 * Drives the routes over stubbed repositories: this covers the HTTP boundary
 * (filters, cursors, privacy) without a database. Query behavior itself has
 * its own PostgreSQL tests in `@fdrive/db`.
 */
async function fixture() {
  const accountId = randomUUID();
  const identityId = randomUUID();
  const fileId = randomUUID();
  const storage = createMemoryStorage();
  await storage.upload("/a.txt", new Uint8Array([1]));
  let principal: Principal = { accountId, identityId, storage, username: "alice", isAdmin: true };
  const event = { ...activityEvent(accountId, identityId), fileId };
  const subject = {
    ownerAccountId: accountId,
    eventId: event.id,
    identityId,
    fileId,
    path: "/a.txt",
    ordinal: 0,
    role: "primary" as const,
    revisionId: null,
  };
  const window = {
    id: randomUUID(),
    ownerAccountId: accountId,
    identityId,
    fileId,
    action: "file.open" as const,
    source: "web" as const,
    evidence: "client_reported" as const,
    contextHash: "private-context",
    generation: 1,
    path: "/a.txt",
    bucketStart: time,
    firstAt: time,
    lastAt: time,
    count: 2,
    outcomeCounts: { unknown: 2 },
    sealedAt: null,
  };
  const boundary = {
    ownerAccountId: accountId,
    nextSequence: 2,
    historyStartsAt: time,
    retainedFrom: null,
  };
  const file = {
    id: fileId,
    identityId,
    path: "/a.txt",
    state: "live" as "live" | "trashed" | "deleted" | "unknown",
    kind: "file" as const,
    generation: 1,
    revisionId: null,
    firstObservedAt: time,
    lastConfirmedAt: time,
    fingerprint: null,
  };
  const repo = {
    list: vi.fn(async (_owner: string, _options: unknown) => [event]),
    subjects: vi.fn(async (_owner: string, _ids: string[]) => [subject]),
    batchSummary: vi.fn(async () => ({ total: 1, outcomes: { success: 1 } })),
    boundary: vi.fn(async (_owner: string) => boundary),
    event: vi.fn(async (owner: string, id: string) =>
      owner === accountId && id === event.id ? event : null,
    ),
    file: vi.fn(async (owner: string, id: string) =>
      owner === accountId && id === fileId
        ? {
            file,
            storage: {
              identityId,
              providerId: randomUUID(),
              providerType: "sftpgo",
              label: "Storage",
              retiredAt: null,
            },
            lastSubject: subject,
            lastEvent: event,
          }
        : null,
    ),
    subjectPage: vi.fn(async (_owner: string, _id: string, _ordinal: number) => [subject]),
    resolveFile: vi.fn(
      async (_owner: string, _identity: string, _path: string) => fileId as string | null,
    ),
    locations: vi.fn(async (_owner: string) => [{ identityId, label: "Storage" }]),
    revisions: vi.fn(
      async (_owner: string, _id: string, _cursor?: string) =>
        [] as { id: string; ownerAccountId: string }[],
    ),
    lineage: vi.fn(
      async (_owner: string, _id: string, _cursor?: string) =>
        [] as {
          id: string;
          eventId: string;
          ownerAccountId: string;
          sourceFileId: string;
          targetFileId: string;
        }[],
    ),
    stream: vi.fn(async (_owner: string, _sequence: number) => [{ id: event.id, sequence: 2 }]),
  };
  const reads = { provisional: vi.fn(async (_owner: string, _identity?: string) => [window]) };
  const identityGet = vi.fn(
    async (_id: string) =>
      ({ id: identityId, accountId }) as { id: string; accountId: string } | null,
  );
  const storageFactory = vi.fn(async (_id: string): Promise<StorageProvider> => storage);
  const admission = vi.fn(async () => window.id);
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/activity",
      SFTPGO_URL: "http://storage.test",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    }),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
    version: "test",
    startedAt: time,
    clock: () => time,
    principalResolver: async () => principal,
    registerRoutes(groups) {
      registerPersonalActivityRoutes(groups, {
        repo: repo as unknown as ActivityRepo,
        reads: reads as unknown as ActivityReadsRepo,
        identities: { get: identityGet } as unknown as IdentityRepo,
        storageFactory,
        cursorSecret: CURSOR_SECRET,
        admitActivity: admission,
      });
    },
  });
  const request = (path = "", init: RequestInit = {}) =>
    app.request(`/api/v1/activity${path}`, {
      ...init,
      headers: {
        cookie: `${COOKIE_NAME}=session`,
        "x-requested-with": "fdrive",
        "content-type": "application/json",
        ...init.headers,
      },
    }) as Promise<
      Omit<Response, "json"> & {
        json(): Promise<PersonalActivityResponse & PersonalActivityEvent & ActivityFileResponse>;
      }
    >;
  return {
    app,
    request,
    repo,
    reads,
    identityGet,
    storageFactory,
    storage,
    admission,
    accountId,
    identityId,
    fileId,
    event,
    subject,
    window,
    file,
    setPrincipal(value: Partial<Principal>) {
      principal = { ...principal, ...value };
    },
  };
}

describe("personal activity HTTP boundary", () => {
  it("serializes a private feed, binds all filters and cursors, and keeps provisional counts", async () => {
    const h = await fixture();
    const response = await h.request(
      `?limit=1&identityId=${h.identityId}&from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z&q=a&source=web`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.items[0]?.sequence).toBe("1");
    expect(body.provisionalReads[0]?.count).toBe(2);
    expect(JSON.stringify(body)).not.toMatch(
      /private-receipt|private-context|ownerAccountId|idempotencyKey/,
    );
    expect(h.repo.list).toHaveBeenCalledWith(
      h.accountId,
      expect.objectContaining({
        identityId: h.identityId,
        q: "a",
        from: new Date("2026-09-01"),
        to: new Date("2026-10-01"),
        source: "web",
        limit: 1,
      }),
    );

    expect(
      (
        await h.request(
          `?limit=1&identityId=${h.identityId}&from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z&q=a&source=web&cursor=${body.nextCursor}`,
        )
      ).status,
    ).toBe(200);
    expect(h.repo.list.mock.calls.at(-1)?.[1]).toHaveProperty("after");
    expect((await h.request(`?cursor=${body.nextCursor}`)).status).toBe(400);
    expect((await h.request("?from=nonsense")).status).toBe(400);
    expect((await h.request("?unknown=1")).status).toBe(400);
    expect((await h.request("", { headers: { authorization: "Bearer secret" } })).status).toBe(403);
    expect((await h.app.request("/api/v1/activity")).status).toBe(401);
  });

  it("declares what history covers so the UI never implies it saw everything", async () => {
    const h = await fixture();

    expect((await (await h.request()).json()).coverage).toEqual({
      mutations: true,
      reads: true,
      observations: "unavailable",
      observationGap: true,
    });
  });

  it("filters read windows, hides them on later pages and batches, and exposes owned locations", async () => {
    const h = await fixture();
    for (const query of [
      "action=file.save",
      "source=native",
      "outcome=success",
      "q=other",
      "from=2026-09-15T00:00:00Z",
      "to=2026-09-13T00:00:00Z",
    ])
      expect((await (await h.request(`?${query}`)).json()).provisionalReads).toEqual([]);

    expect(
      (await (await h.request(`/files/${randomUUID()}/events`)).json()).provisionalReads,
    ).toEqual([]);
    expect(
      (await (await h.request(`/files/${h.fileId}/events?action=file.open&outcome=unknown`)).json())
        .provisionalReads,
    ).toHaveLength(1);

    const batch = await (await h.request(`/batches/${randomUUID()}/events`)).json();
    expect(batch.provisionalReads).toEqual([]);
    expect(batch.batchSummary).toEqual({ total: 1, outcomes: { success: 1 } });

    expect((await (await h.request("/locations")).json()).items).toEqual([
      { identityId: h.identityId, label: "Storage" },
    ]);

    h.reads.provisional.mockResolvedValueOnce([]);
    h.repo.boundary.mockResolvedValueOnce(null as never);
    expect((await (await h.request()).json()).historyStartsAt).toBeNull();
    expect(
      serializeReadWindow({ ...h.window, outcomeCounts: { success: 1, unknown: 1 } }).outcome,
    ).toBe("partial");
    expect(serializeReadWindow({ ...h.window, outcomeCounts: { success: 2 } }).outcome).toBe(
      "success",
    );
    expect(serializeReadWindow({ ...h.window, outcomeCounts: {} }).outcome).toBe("unknown");
    expect(
      serializeReadWindow({ ...h.window, outcomeCounts: { success: 1, unknown: 0 } }).outcome,
    ).toBe("success");
  });

  it("returns immutable event details and pages full subject membership without foreign IDs", async () => {
    const h = await fixture();
    expect((await h.request("/events/invalid")).status).toBe(400);
    expect((await h.request(`/events/${randomUUID()}`)).status).toBe(404);

    h.repo.subjects.mockResolvedValueOnce(
      Array.from({ length: 21 }, (_, ordinal) => ({ ...h.subject, ordinal })),
    );
    const event = await (await h.request(`/events/${h.event.id}`)).json();
    expect(event.subjects).toHaveLength(20);
    expect(event.subjectsTruncated).toBe(true);

    h.repo.subjectPage.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, ordinal) => ({ ...h.subject, ordinal })),
    );
    const page = await (await h.request(`/events/${h.event.id}/subjects`)).json();
    expect(page.items).toHaveLength(100);
    expect(page.items[0]).not.toHaveProperty("ownerAccountId");
    expect(
      (await h.request(`/events/${h.event.id}/subjects?cursor=${page.nextCursor}`)).status,
    ).toBe(200);
    expect(h.repo.subjectPage).toHaveBeenLastCalledWith(h.accountId, h.event.id, 99);
    expect((await h.request(`/events/${randomUUID()}/subjects`)).status).toBe(404);

    const bad = createActivityCursors(CURSOR_SECRET).encode(
      h.accountId,
      `subjects:${h.event.id}`,
      "x",
    );
    expect((await h.request(`/events/${h.event.id}/subjects?cursor=${bad}`)).status).toBe(400);
  });

  it("resolves and live-checks a file's current location while preserving unavailable history", async () => {
    const h = await fixture();
    expect(
      (await (await h.request(`/files/resolve?identityId=${h.identityId}&path=/a.txt`)).json()).id,
    ).toBe(h.fileId);
    h.repo.resolveFile.mockResolvedValueOnce(null);
    expect(
      (await h.request(`/files/resolve?identityId=${h.identityId}&path=/missing`)).status,
    ).toBe(404);
    expect((await h.request(`/files/resolve?identityId=${h.identityId}`)).status).toBe(200);
    expect(h.repo.resolveFile).toHaveBeenLastCalledWith(h.accountId, h.identityId, "/");
    expect((await h.request("/files/resolve?identityId=nonsense&path=/a.txt")).status).toBe(400);

    const file = await (await h.request(`/files/${h.fileId}`)).json();
    expect(file).toMatchObject({
      availability: "live",
      currentPath: "/a.txt",
      lastKnownPath: "/a.txt",
      label: "Storage",
    });
    expect((await h.request(`/files/${randomUUID()}`)).status).toBe(404);

    h.identityGet.mockResolvedValueOnce(null);
    expect((await (await h.request(`/files/${h.fileId}`)).json()).availability).toBe("unavailable");
    h.file.state = "trashed";
    expect((await (await h.request(`/files/${h.fileId}`)).json()).currentPath).toBeNull();
    h.file.state = "live";
    h.storageFactory.mockRejectedValueOnce(Error("offline"));
    expect((await (await h.request(`/files/${h.fileId}`)).json()).availability).toBe("unavailable");
    h.storageFactory.mockResolvedValueOnce({
      ...h.storage,
      download: async () => {
        throw new StorageError("forbidden", "denied");
      },
    });
    expect((await (await h.request(`/files/${h.fileId}`)).json()).availability).toBe("unavailable");
    await h.storage.deleteFile("/a.txt");
    expect((await (await h.request(`/files/${h.fileId}`)).json()).availability).toBe("unknown");
    h.setPrincipal({ accountId: randomUUID() });
    expect((await h.request(`/files/${h.fileId}`)).status).toBe(404);
  });

  it("falls back through every recorded name when the last subject has no path", async () => {
    const h = await fixture();
    const journey = (lastSubject: unknown, lastEvent: unknown) =>
      h.repo.file.mockResolvedValueOnce({
        file: h.file,
        storage: { identityId: h.identityId, label: "Storage" },
        lastSubject,
        lastEvent,
      } as never);

    journey({ path: null, revisionId: null }, { ...h.event, after: { path: "/b.txt" } });
    expect((await (await h.request(`/files/${h.fileId}`)).json()).lastKnownPath).toBe("/b.txt");

    journey(
      { path: null, revisionId: null },
      { ...h.event, after: null, before: { path: "/c.txt" } },
    );
    expect((await (await h.request(`/files/${h.fileId}`)).json()).lastKnownPath).toBe("/c.txt");

    journey(
      { path: null, revisionId: null },
      { ...h.event, after: null, before: null, occurredAt: null },
    );
    const bare = await (await h.request(`/files/${h.fileId}`)).json();
    expect(bare.lastKnownPath).toBe("/");
    expect(bare.lastConfirmedAt).toBeNull();
  });

  it("pages lineage and revisions with owner-bound cursors and safe path snapshots", async () => {
    const h = await fixture();
    h.repo.lineage.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, index) => ({
        id: randomUUID(),
        eventId: h.event.id,
        ownerAccountId: h.accountId,
        sourceFileId: index === 0 ? h.fileId : randomUUID(),
        targetFileId: randomUUID(),
      })),
    );
    const lineage = await (await h.request(`/files/${h.fileId}/lineage`)).json();
    expect(lineage.items[0]).toMatchObject({ sourcePath: "/a.txt", targetPath: null });
    expect(lineage.items[1]).toMatchObject({ sourcePath: null, targetPath: null });
    expect(lineage.items[0]).not.toHaveProperty("ownerAccountId");
    expect(
      (await h.request(`/files/${h.fileId}/lineage?cursor=${lineage.nextCursor}`)).status,
    ).toBe(200);

    h.repo.revisions.mockResolvedValueOnce(
      Array.from({ length: 100 }, () => ({ id: randomUUID(), ownerAccountId: h.accountId })),
    );
    const revisions = await (await h.request(`/files/${h.fileId}/revisions`)).json();
    expect(revisions.items[0]).not.toHaveProperty("ownerAccountId");
    expect(
      (await h.request(`/files/${h.fileId}/revisions?cursor=${revisions.nextCursor}`)).status,
    ).toBe(200);
  });

  it("accepts explicit client gestures through admission and rejects spoofed server actions", async () => {
    const h = await fixture();
    const input = {
      identityId: h.identityId,
      requestId: randomUUID(),
      at: time.toISOString(),
      path: "/a.txt",
      action: "file.open",
    };

    expect(
      (await h.request("/client-events", { method: "POST", body: JSON.stringify(input) })).status,
    ).toBe(202);
    expect(h.admission).toHaveBeenCalledOnce();
    expect(
      (
        await h.request("/client-events", {
          method: "POST",
          body: JSON.stringify({ ...input, action: "file.delete" }),
        })
      ).status,
    ).toBe(400);
  });

  it("streams committed owner sequences and honors revocation and opaque replay cursors", async () => {
    const h = await fixture();
    const verify = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    h.setPrincipal({ verifyAuthority: verify });

    const body = await (await h.request("/stream")).text();
    expect(body).toContain(h.event.id);
    expect(body).not.toContain(h.accountId);
    expect(h.repo.stream).toHaveBeenCalledWith(h.accountId, 1);

    const cursor = createActivityCursors(CURSOR_SECRET).encode(h.accountId, "stream", "0");
    verify.mockResolvedValueOnce(true);
    await (await h.request(`/stream?cursor=${cursor}`)).text();
    expect(h.repo.stream).toHaveBeenCalledWith(h.accountId, 0);

    expect((await h.request("/stream?cursor=tampered")).status).toBe(400);
    const negative = createActivityCursors(CURSOR_SECRET).encode(h.accountId, "stream", "-1");
    expect((await h.request(`/stream?cursor=${negative}`)).status).toBe(400);

    const broken = await fixture();
    broken.setPrincipal({ verifyAuthority: vi.fn(async () => true) });
    broken.repo.stream.mockRejectedValueOnce(Error("private database error"));
    expect(await (await broken.request("/stream")).text()).not.toContain("private database error");

    // A full page means more is waiting, so the loop reads again without idling.
    const busy = await fixture();
    busy.setPrincipal({ verifyAuthority: vi.fn().mockResolvedValueOnce(true) });
    busy.repo.boundary.mockResolvedValueOnce(null as never);
    busy.repo.stream.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(), sequence: index + 1 })),
    );
    expect(await (await busy.request("/stream")).text()).not.toContain("event: ping");
    expect(busy.repo.stream).toHaveBeenCalledWith(busy.accountId, 0);

    const invalidPosition = createActivityCursors(CURSOR_SECRET).encode(
      h.accountId,
      JSON.stringify({ limit: 50 }),
      JSON.stringify(["not-a-date", randomUUID()]),
    );
    expect((await h.request(`?cursor=${invalidPosition}`)).status).toBe(400);
  });
});
