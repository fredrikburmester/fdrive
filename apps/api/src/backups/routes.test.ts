import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BackupRetainedError } from "@fdrive/backup";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { Logger } from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { BackupModule } from "./module.js";
import { registerBackupRoutes } from "./routes.js";

const account = randomUUID(),
  identity = randomUUID(),
  runId = randomUUID(),
  destinationId = randomUUID();
const schedule = {
  frequency: "manual",
  timezone: "UTC",
  hour: 3,
  daily: 7,
  weekly: 4,
  monthly: 12,
};
let directory: string;
let fixture: ReturnType<typeof build>;
function build() {
  const configuration = {
    installation_id: randomUUID(),
    recipient: "public-recipient",
    confirmed: true,
    schedule,
    next_run_at: null,
    restored: false,
  };
  const run = {
    id: runId,
    created_at: new Date(),
    completed_at: new Date(),
    state: "complete",
    bytes: "10",
    sha256: "a".repeat(64),
    error: null,
    pinned: false,
    coverage: [],
    artifact: "retained",
    verified_at: null,
    verification_requested: false,
    verification_error: null,
  };
  const attachment = {
    id: randomUUID(),
    version_id: randomUUID(),
    label: "Router",
    filename: "router.zip",
    source_date: new Date(),
    notes: "saved copy",
    uploaded_at: new Date(),
    bytes: "3",
    sha256: "a".repeat(64),
  };
  const destination = {
    id: destinationId,
    name: "Bucket",
    type: "s3",
    config: {
      bucket: "test",
      prefix: "fdrive",
      retainedProbe: { name: "probe-kept", retentionUntil: "2030-01-01T00:00:00.000Z" },
    },
    enabled: true,
    tested_at: new Date(),
  };
  const store = {
    event: vi.fn(),
    owner: vi.fn().mockResolvedValue(true),
    configuration: vi.fn().mockResolvedValue(configuration),
    destinations: vi.fn().mockResolvedValue([destination]),
    attachments: vi.fn().mockResolvedValue([attachment]),
    runs: vi.fn().mockResolvedValue([run]),
    run: vi.fn().mockResolvedValue(run),
    deliveries: vi.fn().mockResolvedValue([
      {
        destination_id: destinationId,
        name: "Bucket",
        state: "complete",
        error: null,
        verified_at: new Date(),
      },
    ]),
    setRun: vi.fn(),
    pin: vi.fn(),
    setSchedule: vi.fn(),
    destinationSchedule: vi.fn(),
    destination: vi.fn().mockResolvedValue(destination),
    deleteDestination: vi.fn(),
    attachment: vi.fn().mockResolvedValue(attachment),
    deleteAttachment: vi.fn(),
  };
  const engine = {
    operations: {
      status: vi.fn().mockResolvedValue({ workerSeenAt: null, estimate: null, rehearsal: null }),
      inventories: vi
        .fn()
        .mockResolvedValue({ [runId]: { attachmentVersions: [attachment.version_id] } }),
      requestEstimate: vi.fn().mockResolvedValue(runId),
      recordRehearsal: vi.fn(),
    },
    challenge: vi.fn().mockResolvedValue("challenge"),
    confirm: vi.fn(),
    queue: vi.fn().mockResolvedValue(runId),
    remove: vi.fn(),
    testDestination: vi.fn(),
    artifact: () => join(directory, "archive"),
  };
  const query = vi.fn().mockResolvedValue({ rows: [{ id: runId }] });
  const pool = { query, connect: async () => ({ query, release: vi.fn() }) };
  const attachments = {
    upload: vi.fn(async (_input, body: Readable) => {
      for await (const _ of body) {
        /* consume upload */
      }
      return attachment.id;
    }),
    download: vi.fn(async () => Readable.from([Buffer.from("ZIP")])),
  };
  const module = {
    store,
    engine,
    pool,
    gatePool: pool,
    attachments,
    enabled: true,
    destinationRecord: vi.fn().mockResolvedValue(destination),
  };
  const authenticate = vi.fn();
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://unused/test",
      SFTPGO_URL: "http://unused.invalid",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    }),
    logger,
    version: "test",
    startedAt: new Date(),
    principalResolver: async () => ({
      accountId: account,
      identityId: identity,
      username: "owner",
      isAdmin: true,
      storage: createMemoryStorage(),
    }),
    registerRoutes: (groups) =>
      registerBackupRoutes(groups, module as unknown as BackupModule, authenticate),
  });
  async function request(
    path = "",
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return app.request(`/api/v1/system/backups${path}`, {
      method,
      headers: {
        cookie: "fdrive_session=owner-session",
        "x-requested-with": "fdrive",
        "content-type": "application/json",
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  const unlock = () =>
    request("/unlock", "POST", { credential: { password: "test-owner-password" } });
  return { module, store, engine, app, request, unlock, authenticate, attachment, run };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "backup-routes-"));
  await writeFile(join(directory, "archive"), "0123456789");
  fixture = build();
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
it("protects the collection and every sensitive route from non-owners and bearer tokens", async () => {
  expect((await fixture.request()).status).toBe(200);
  fixture.store.owner.mockResolvedValue(false);
  expect((await fixture.request()).status).toBe(403);
  expect((await fixture.unlock()).status).toBe(403);
  fixture.store.owner.mockResolvedValue(true);
  expect(
    (await fixture.request("", "GET", undefined, { authorization: "Bearer token" })).status,
  ).toBe(403);
  expect((await fixture.request("", "GET", undefined, { cookie: "" })).status).toBe(403);
  expect(
    (await fixture.request("/runs", "POST", { destinationIds: [], metadataOnly: false })).status,
  ).toBe(401);
  fixture.module.enabled = false;
  expect((await fixture.request()).status).toBe(400);
});
it("requires CSRF and fresh owner authentication, and returns only public backup summaries", async () => {
  expect(
    (
      await fixture.request(
        "/unlock",
        "POST",
        { credential: { password: "x" } },
        { "x-requested-with": "" },
      )
    ).status,
  ).toBe(403);
  expect((await fixture.unlock()).status).toBe(200);
  expect(fixture.authenticate).toHaveBeenCalledWith(
    account,
    identity,
    { password: "test-owner-password" },
    expect.any(String),
  );
  const body = (await (await fixture.request()).json()) as {
    destinations: unknown[];
    runs: { downloadable: boolean }[];
  };
  expect(body).not.toHaveProperty("masterKey");
  expect(body.destinations[0]).not.toHaveProperty("secret");
  expect(body.destinations[0]).toMatchObject({
    retainedProbe: { name: "probe-kept", retentionUntil: "2030-01-01T00:00:00.000Z" },
  });
  expect(body.runs[0]?.downloadable).toBe(true);
  expect((await fixture.request("/key", "POST", { recipient: "age-public" })).status).toBe(200);
  expect(
    (await fixture.request("/key/confirm", "POST", { proof: "decrypted challenge" })).status,
  ).toBe(200);
  expect((await fixture.request("/schedule", "PUT", schedule)).status).toBe(200);
  expect(
    (await fixture.request(`/destinations/${destinationId}/schedule`, "PUT", { schedule: null }))
      .status,
  ).toBe(200);
  expect(
    (await fixture.request("/runs", "POST", { destinationIds: [], metadataOnly: false })).status,
  ).toBe(202);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 601_000);
  expect((await fixture.request("/runs", "POST", {})).status).toBe(401);
});
it("streams resumable archives and rejects malformed or unsatisfiable ranges", async () => {
  await fixture.unlock();
  const path = `/runs/${runId}/download`;
  const full = await fixture.request(path);
  expect(await full.text()).toBe("0123456789");
  expect(full.headers.get("cache-control")).toBe("no-store");
  const partial = await fixture.request(path, "GET", undefined, { range: "bytes=2-4" });
  expect(partial.status).toBe(206);
  expect(await partial.text()).toBe("234");
  expect(partial.headers.get("content-range")).toBe("bytes 2-4/10");
  const rest = await fixture.request(path, "GET", undefined, { range: "bytes=8-" });
  expect(await rest.text()).toBe("89");
  for (const range of ["bytes=-5", "bytes=11-12", "bytes=9-1", "units=0-1"])
    expect((await fixture.request(path, "GET", undefined, { range })).status).toBe(416);
  fixture.store.run.mockResolvedValue(null);
  expect((await fixture.request(path)).status).toBe(404);
  expect((await fixture.request("/runs/not-uuid/download")).status).toBe(400);
});
it("enqueues run actions and validates existing run state", async () => {
  await fixture.unlock();
  expect((await fixture.request(`/runs/${runId}/verify`, "POST", {})).status).toBe(202);
  expect((await fixture.request(`/runs/${runId}/pin`, "PUT", { pinned: true })).status).toBe(200);
  expect((await fixture.request(`/runs/${runId}/cancel`, "POST", {})).status).toBe(409);
  fixture.run.state = "capturing";
  expect((await fixture.request(`/runs/${runId}/cancel`, "POST", {})).status).toBe(200);
  expect((await fixture.request(`/runs/${runId}/retry`, "POST", {})).status).toBe(409);
  fixture.run.state = "partial";
  expect((await fixture.request(`/runs/${runId}/retry`, "POST", {})).status).toBe(202);
  expect((await fixture.request(`/runs/${runId}`, "DELETE")).status).toBe(200);
  fixture.engine.remove.mockRejectedValueOnce(
    new BackupRetainedError([
      { name: "Locked bucket", retentionUntil: "2030-01-01T00:00:00.000Z" },
    ]),
  );
  const retained = await fixture.request(`/runs/${runId}`, "DELETE");
  expect(retained.status).toBe(409);
  expect(((await retained.json()) as { error: { message: string } }).error.message).toContain(
    "Locked bucket until 2030-01-01T00:00:00.000Z",
  );
  fixture.engine.remove.mockRejectedValueOnce(Error("destination exploded"));
  expect((await fixture.request(`/runs/${runId}`, "DELETE")).status).toBe(500);
  const input = {
    type: "s3",
    name: "Offsite",
    endpoint: "https://example.invalid",
    region: "test",
    bucket: "backup-test",
    prefix: "fdrive",
    pathStyle: false,
    accessKeyId: "test",
    secretAccessKey: "test",
  };
  expect((await fixture.request("/destinations", "POST", input)).status).toBe(201);
  expect((await fixture.request(`/destinations/${destinationId}`, "PUT", input)).status).toBe(200);
  expect((await fixture.request(`/destinations/${destinationId}/test`, "POST", {})).status).toBe(
    200,
  );
  expect((await fixture.request(`/destinations/${destinationId}`, "DELETE")).status).toBe(200);
  fixture.store.destination.mockResolvedValue(null);
  expect((await fixture.request(`/destinations/${destinationId}/test`, "POST", {})).status).toBe(
    404,
  );
});
it("stores opaque ZIPs with metadata and never accepts them as executable configuration", async () => {
  await fixture.unlock();
  const metadata = Buffer.from(
    JSON.stringify({
      label: "Router",
      filename: "router.zip",
      sourceDate: null,
      notes: "Restore outside fdrive",
    }),
  ).toString("base64");
  const upload = (
    path: string,
    method = "POST",
    headers: Record<string, string> = { "x-backup-metadata": metadata },
  ) =>
    fixture.app.request(`/api/v1/system/backups${path}`, {
      method,
      headers: { cookie: "fdrive_session=owner-session", "x-requested-with": "fdrive", ...headers },
      body: "ZIP",
    });
  expect((await upload("/attachments")).status).toBe(201);
  expect((await upload(`/attachments/${fixture.attachment.id}`, "PUT")).status).toBe(201);
  expect((await upload("/attachments", "POST", {})).status).toBe(400);
  expect((await upload("/attachments", "POST", { "x-backup-metadata": "broken" })).status).toBe(
    400,
  );
  const download = await fixture.request(`/attachments/${fixture.attachment.id}/download`);
  expect(await download.text()).toBe("ZIP");
  expect(download.headers.get("content-disposition")).toContain("attachment;");
  expect((await fixture.request(`/attachments/${fixture.attachment.id}`, "DELETE")).status).toBe(
    200,
  );
  fixture.store.attachment.mockResolvedValue(null);
  expect((await fixture.request(`/attachments/${fixture.attachment.id}/download`)).status).toBe(
    404,
  );
  expect((await upload(`/attachments/${fixture.attachment.id}`, "PUT")).status).toBe(404);
  expect((await fixture.request("/schedule", "PUT", { timezone: "invalid" })).status).toBe(400);
});

it("rejects oversized JSON and bad bodies and never reuses failed reauthentication", async () => {
  await fixture.unlock();
  const send = (body?: string) =>
    fixture.app.request("/api/v1/system/backups/key", {
      method: "POST",
      headers: { cookie: "fdrive_session=owner-session", "x-requested-with": "fdrive" },
      ...(body === undefined ? {} : { body }),
    });
  expect((await send()).status).toBe(400);
  expect((await send("broken JSON")).status).toBe(400);
  expect((await send(JSON.stringify({ recipient: "a".repeat(65_537) }))).status).toBe(413);
  fixture.authenticate.mockRejectedValueOnce(Error("Credential revoked"));
  expect((await fixture.unlock()).status).toBe(500);
  expect((await fixture.request("/key", "POST", { recipient: "age-key" })).status).toBe(401);
  await fixture.unlock();
  fixture.store.run.mockResolvedValue(null);
  for (const action of ["cancel", "retry"])
    expect((await fixture.request(`/runs/${runId}/${action}`, "POST", {})).status).toBe(409);
  fixture.store.run.mockResolvedValue({ ...fixture.run, state: "deleted", artifact: null });
  expect((await fixture.request(`/runs/${runId}/download`)).status).toBe(404);
});

it("bounds sensitive sessions and frees expired authorizations", async () => {
  for (let index = 0; index < 1000; index++) {
    expect(
      (
        await fixture.request(
          "/unlock",
          "POST",
          { credential: { password: "test" } },
          { cookie: `fdrive_session=session-${index}` },
        )
      ).status,
    ).toBe(200);
  }
  expect((await fixture.unlock()).status).toBe(429);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 601_000);
  expect((await fixture.unlock()).status).toBe(200);
  expect(
    (
      await fixture.request("/attachments", "POST", undefined, {
        "x-backup-metadata": Buffer.from(
          JSON.stringify({ label: "ZIP", filename: "test.zip", notes: "", sourceDate: null }),
        ).toString("base64"),
      })
    ).status,
  ).toBe(400);
});

it("requires fresh owner access for estimates and rehearsal records and reports captured ZIP versions", async () => {
  expect((await fixture.request("/estimate", "POST")).status).toBe(401);
  await fixture.unlock();
  expect((await fixture.request("/estimate", "POST")).status).toBe(202);
  const report = {
    sourceInstallationId: randomUUID(),
    snapshotId: runId,
    completedAt: new Date().toISOString(),
    migrations: [],
    tableCount: 29,
    blobCount: 1,
    result: "passed",
  };
  expect((await fixture.request("/rehearsal", "POST", report)).status).toBe(200);
  expect(fixture.engine.operations.recordRehearsal).toHaveBeenCalledWith(report);
  expect(
    (await fixture.request("/rehearsal", "POST", { ...report, result: "failed" })).status,
  ).toBe(400);
  fixture.store.deliveries.mockResolvedValue([
    {
      destination_id: destinationId,
      name: "Bucket",
      state: "complete",
      error: null,
      verified_at: new Date(),
      retention_until: new Date("2027-01-01T00:00:00Z"),
    },
  ] as never);
  type StatusBody = {
    attachments: Array<{ lastCapturedBackupId: string | null; lastCapturedAt: string | null }>;
    runs: Array<{ deliveries: Array<{ retentionUntil: string | null }> }>;
  };
  let status = (await (await fixture.request()).json()) as StatusBody;
  expect(status.attachments[0]?.lastCapturedBackupId).toBe(runId);
  expect(status.runs[0]?.deliveries[0]?.retentionUntil).toBe("2027-01-01T00:00:00.000Z");
  fixture.engine.operations.inventories.mockResolvedValue({ [runId]: { attachmentVersions: [] } });
  status = (await (await fixture.request()).json()) as StatusBody;
  expect(status.attachments[0]?.lastCapturedAt).toBeNull();
});
