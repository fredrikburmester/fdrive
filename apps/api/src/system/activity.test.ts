import {
  type ActivityOperation,
  FEATURE_IDS,
  SystemActivityResponse,
  type SystemFeaturesResponse,
  type SystemOfficeResponse,
  WorkerActivity,
} from "@fdrive/contracts";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { DISABLED_FEATURES } from "../features/service.js";
import { activityPercent, registerActivityRoutes, shapeSystemActivity } from "./activity.js";

const at = "2026-09-12T12:00:00Z";
const operation: ActivityOperation = {
  id: "job",
  kind: "thumbnailRebuild",
  features: ["thumbnails"],
  revision: 1,
  state: "running",
  phase: "processing",
  processed: 63,
  total: 100,
  errors: 0,
  skipped: 0,
  unit: "files",
  startedAt: at,
  finishedAt: null,
};
const features: SystemFeaturesResponse = {
  configuration: {
    version: 1,
    revision: 1,
    values: { ...DISABLED_FEATURES, thumbnails: true },
    walkthroughComplete: true,
  },
  source: "settings",
  statuses: FEATURE_IDS.map((id) => ({
    id,
    state: id === "thumbnails" ? "ready" : "off",
    detail: "",
  })),
  roots: [],
};
const office: SystemOfficeResponse = {
  configuration: {
    revision: 0,
    enabled: false,
    editingEnabled: false,
    editingProviderId: null,
    editorUsernames: [],
  },
  product: "onlyoffice",
  status: "off",
  activeProviderId: null,
  activeProviderLabel: null,
};
const snapshot = (operations: ActivityOperation[] = [operation]) => ({
  instanceId: "worker",
  observedAt: at,
  operations,
});
const source = (operations: ActivityOperation[] = [operation]) => ({
  ok: true as const,
  data: snapshot(operations),
});
const item = (operations: ActivityOperation[], id = "thumbnails") =>
  shapeSystemActivity(features, "off", source(operations), null, at).items.find(
    (entry) => entry.id === id,
  );

describe("activity percentages", () => {
  it("weights matching finite jobs and caps running work below 100", () => {
    expect(activityPercent([operation])).toBe(63);
    expect(activityPercent([operation, { ...operation, processed: 1, total: 1 }])).toBe(63);
    expect(activityPercent([{ ...operation, processed: 101 }])).toBe(99);
  });
  it.each([
    [],
    [{ ...operation, total: null }],
    [{ ...operation, total: 0 }],
    [{ ...operation, phase: "discovering" as const }],
    [{ ...operation, state: "waiting" as const }],
    [operation, { ...operation, kind: "scan" as const }],
    [operation, { ...operation, unit: "entries" as const }],
  ])("omits an untrustworthy or mixed ratio: %j", (...operations) => {
    expect(activityPercent(operations as ActivityOperation[])).toBeNull();
  });
});

describe("activity state", () => {
  it("shows processing independently of readiness, and ends the spinner on completion", () => {
    expect(item([operation])).toMatchObject({
      state: "working",
      percent: 63,
      operationIds: ["worker:job"],
    });
    expect(item([operation], "features")).toMatchObject({ state: "working", percent: null });
    expect(item([{ ...operation, state: "completed", finishedAt: at }])).toMatchObject({
      state: "idle",
      percent: null,
    });
    expect(item([])).toMatchObject({ state: "idle", percent: null });
  });
  it("keeps active work visible alongside errors and distinguishes stopped jobs", () => {
    expect(item([{ ...operation, errors: 1 }])).toMatchObject({ state: "working", warning: true });
    expect(item([{ ...operation, state: "stopped" }])).toMatchObject({
      state: "failed",
      percent: null,
      detail: expect.stringContaining("Stopped"),
    });
    expect(item([{ ...operation, state: "waiting", phase: "waiting" }])).toMatchObject({
      state: "waiting",
      percent: null,
    });
  });
  it("shows unknown telemetry rather than inferring idle from absent counters", () => {
    const body = shapeSystemActivity(
      features,
      "unavailable",
      { ok: false, reason: "unreachable", detail: "404" },
      null,
      at,
    );
    expect(body.items.find((entry) => entry.id === "thumbnails")).toMatchObject({
      state: "unavailable",
      percent: null,
    });
    expect(body.items.find((entry) => entry.id === "office")).toMatchObject({
      state: "unavailable",
    });
    expect(body.items.find((entry) => entry.id === "general")).toMatchObject({ state: "idle" });
  });
  it("shows runtime transitions without inventing a percentage", () => {
    const preparing = {
      ...features,
      statuses: [
        { id: "thumbnails" as const, state: "preparing" as const, detail: "Preparing worker" },
      ],
    };
    const body = shapeSystemActivity(preparing, "starting", source(), null, at);
    expect(body.items.find((entry) => entry.id === "thumbnails")).toMatchObject({
      state: "working",
      percent: null,
    });
    expect(body.items.find((entry) => entry.id === "office")).toMatchObject({ state: "working" });
    expect(SystemActivityResponse.safeParse(body).success).toBe(true);
  });
});

function fixture(admin = true) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json(snapshot()));
  const readFeatures = vi.fn(async () => features);
  const readOffice = vi.fn(async () => office);
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/fdrive",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    }),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    version: "1",
    startedAt: new Date(),
    principalResolver: async () =>
      ({
        accountId: "a",
        identityId: "i",
        username: "alice",
        isAdmin: admin,
        storage: {},
      }) as Principal,
    connectionStatus: async () => ({
      required: false,
      providers: [{ type: "sftpgo", host: "sftpgo" }],
    }),
    registerRoutes(groups) {
      registerActivityRoutes(groups, {
        indexerUrl: "http://indexer",
        ocrUrl: undefined,
        fetch,
        features: readFeatures,
        office: readOffice,
      });
    },
  });
  return { app, fetch, readFeatures, readOffice };
}

it("isolates runtime status failures while another worker keeps processing", async () => {
  const { app, readFeatures, readOffice } = fixture();
  readFeatures.mockRejectedValue(new Error("settings unavailable"));
  readOffice.mockRejectedValue(new Error("Office unavailable"));
  const response = await app.request("/api/v1/system/activity");
  expect(response.status).toBe(200);
  const body = SystemActivityResponse.parse(await response.json());
  expect(body.items.find((entry) => entry.id === "thumbnails")).toMatchObject({
    state: "working",
    warning: true,
    detail: expect.stringContaining("Feature status unavailable"),
  });
  expect(body.items.find((entry) => entry.id === "office")).toMatchObject({ state: "unavailable" });
  const failed = shapeSystemActivity(
    { ...features, statuses: [{ id: "imageSearch", state: "failed", detail: "Model failed" }] },
    "off",
    source(),
    null,
    at,
  );
  expect(failed.items.find((entry) => entry.id === "imageSearch")).toMatchObject({
    state: "failed",
    detail: expect.stringContaining("Model failed"),
  });
  expect(failed.items.find((entry) => entry.id === "thumbnails")?.state).toBe("working");
});

it("authorizes before probing, shares concurrent reads and only calls /activity", async () => {
  const denied = fixture(false);
  expect((await denied.app.request("/api/v1/system/activity")).status).toBe(403);
  expect(denied.fetch).not.toHaveBeenCalled();
  expect(denied.readFeatures).not.toHaveBeenCalled();
  const allowed = fixture();
  const responses = await Promise.all([
    allowed.app.request("/api/v1/system/activity"),
    allowed.app.request("/api/v1/system/activity"),
  ]);
  expect(allowed.fetch).toHaveBeenCalledTimes(1);
  expect(String(allowed.fetch.mock.calls[0]?.[0])).toBe("http://indexer/activity");
  expect(allowed.readFeatures).toHaveBeenCalledTimes(1);
  expect(responses[0]?.headers.get("cache-control")).toBe("no-store");
  expect(
    SystemActivityResponse.parse(await responses[0]?.json()).items.find(
      (entry) => entry.id === "thumbnails",
    )?.percent,
  ).toBe(63);
  expect(WorkerActivity.safeParse(snapshot()).success).toBe(true);
});
