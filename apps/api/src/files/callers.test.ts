import type { JobStatus } from "@fdrive/contracts";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { activityFixture } from "../../test/activity-fixture.js";
import { recordingFileOperations, testFileOperations } from "../../test/file-operations.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createEventBus } from "../events/bus.js";
import { registerFsRoutes } from "../fs/routes.js";
import { createJobRunner } from "../jobs/runner.js";
import { copyPath, createFile, editFile, restorePath, trashPath } from "../mcp/file-tools.js";
import { type McpToolDeps, runCreateFolder, runMovePath } from "../mcp/handlers.js";
import type { TokenPrincipal } from "../tokens/principal.js";
import { registerTrashRoutes } from "../trash/routes.js";
import type { FileOperations } from "./operations.js";

const IDENTITY = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const CLOCK = () => new Date("2026-11-15T00:00:00.000Z");
const ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_STORAGE_ROOT: "/srv/files",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

function seeded() {
  return createMemoryStorage({ "/a.txt": "a", "/b.txt": "b", "/dir/c.txt": "c" });
}

type Activity = ReturnType<typeof activityFixture>;

/** The web's file and Trash routes over memory storage, changing files through `files`. */
function webHarness(files: (activity: Activity) => FileOperations) {
  const storage = seeded();
  const activity = activityFixture(CLOCK);
  const principal = {
    accountId: ACCOUNT,
    identityId: IDENTITY,
    username: "alice",
    storage,
    isAdmin: false,
  };
  const app = createApp({
    config: loadConfig(ENV),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    version: "1.0.0",
    startedAt: CLOCK(),
    clock: CLOCK,
    principalResolver: async () => principal,
    setupRequired: async () => false,
    registerRoutes: (groups) => {
      registerFsRoutes(groups, {
        activity: activity.service,
        files: files(activity),
        jobRunner: createJobRunner({ clock: CLOCK, bus: createEventBus() }),
        jobMaxBytes: 1_000_000,
        folderSize: {
          indexQueries: { subtreeSize: async () => ({ bytes: 0, files: 0 }) },
          resolver: { scopesFor: async () => [] },
          indexed: async () => false,
        },
      });
      registerTrashRoutes(groups, { activity: activity.service, files: files(activity) });
    },
  });
  async function send(path: string, init: RequestInit & { json?: unknown } = {}) {
    const { json, ...rest } = init;
    const response = await app.request(path, {
      method: json === undefined ? (rest.method ?? "GET") : "POST",
      ...rest,
      headers: {
        "x-requested-with": "fdrive",
        "sec-fetch-site": "same-origin",
        ...(json === undefined ? {} : { "content-type": "application/json" }),
        ...rest.headers,
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
    return response;
  }
  return { app, storage, send, activity };
}

function mcpHarness(files: (activity: Activity) => FileOperations) {
  const storage = seeded();
  const activity = activityFixture(CLOCK);
  const principal: TokenPrincipal = {
    accountId: ACCOUNT,
    identityId: IDENTITY,
    username: "alice",
    isAdmin: false,
    storage,
    tokenAccess: { mode: "full", paths: ["/"] },
  };
  let child = 0;
  const deps: McpToolDeps = {
    files: files(activity),
    nextOperationId: () => `mcp:${child++}`,
    indexQueries: {} as McpToolDeps["indexQueries"],
    searchService: {} as McpToolDeps["searchService"],
    scopeResolver: { scopesFor: async () => [] },
    indexed: async () => false,
    publicUrl: async () => null,
    indexerClient: null,
    clock: CLOCK,
  };
  return { deps, principal, storage, activity };
}

async function jobDone(app: ReturnType<typeof createApp>, id: string): Promise<JobStatus> {
  for (let tries = 0; tries < 100; tries++) {
    const job = (await (await app.request(`/api/v1/fs/jobs/${id}`)).json()) as JobStatus;
    if (job.state !== "queued" && job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the job did not finish");
}

describe("every caller changes files through the file operations", () => {
  it("the web's file routes", async () => {
    const recorded = recordingFileOperations();
    const h = webHarness(() => recorded.files);
    await h.send("/api/v1/fs/upload?path=/up.txt", { method: "PUT", body: "up" });
    await h.send("/api/v1/fs/mkdir", { json: { path: "/new" } });
    await h.send("/api/v1/fs/move", { json: { path: "/a.txt", target: "/new/a.txt" } });
    await h.send("/api/v1/fs/move-many", {
      json: { items: [{ path: "/b.txt", target: "/b2.txt" }] },
    });
    await h.send("/api/v1/fs/copy", { json: { path: "/b2.txt", target: "/b3.txt" } });
    await h.send("/api/v1/fs/rename", { json: { path: "/b3.txt", newName: "b4.txt" } });
    await h.send("/api/v1/fs/duplicate", { json: { path: "/b4.txt" } });
    await h.send("/api/v1/fs/delete", { json: { items: [{ path: "/b4.txt", kind: "file" }] } });
    const accepted = await h.send("/api/v1/fs/compress", {
      json: { paths: ["/dir"], format: "tar.gz" },
    });
    const { jobId } = (await accepted.json()) as { jobId: string };
    expect((await jobDone(h.app, jobId)).state).toBe("done");
    expect(recorded.calls).toEqual([
      "upload /up.txt",
      "mkdir /new",
      "move /a.txt",
      "move /b.txt",
      "copy /b2.txt",
      "move /b3.txt",
      "copy /b4.txt",
      "trash /b4.txt",
      // The archive job's own write.
      "upload /dir.tar.gz",
    ]);
  });

  it("the web's Trash routes", async () => {
    const recorded = recordingFileOperations();
    const h = webHarness(() => recorded.files);
    for (const path of ["/a.txt", "/b.txt", "/dir"]) await h.storage.trash.put(path);
    const ids = (await h.storage.trash.list()).entries.map((entry) => entry.id).sort();
    const [first, second] = ids;
    await h.send("/api/v1/trash/restore", { json: { ids: [first] } });
    await h.send("/api/v1/trash/purge", { json: { ids: [second] } });
    await h.send("/api/v1/trash/empty", { method: "POST" });
    expect(recorded.calls).toEqual([
      `restore ${first}`,
      `purge ${second}`,
      ...ids.slice(2).map((id) => `purge ${id}`),
    ]);
  });

  it("MCP's write tools", async () => {
    const recorded = recordingFileOperations();
    const h = mcpHarness(() => recorded.files);
    await runCreateFolder(h.deps, h.principal, { path: "/made" });
    await runMovePath(h.deps, h.principal, { src: "/a.txt", dst: "/made/a.txt" });
    await copyPath(h.deps, h.principal, { src: "/b.txt", dst: "/made/b.txt" });
    await createFile(h.deps, h.principal, { path: "/made/text.txt", text: "text" });
    await createFile(h.deps, h.principal, { path: "/made/raw.bin", data: "AP8=" });
    const read = await import("../mcp/content.js").then(({ readStoredFile }) =>
      readStoredFile(h.deps, h.principal, "/made/text.txt"),
    );
    await editFile(h.deps, h.principal, {
      path: "/made/text.txt",
      text: "edited",
      expected_sha256: read.sha256,
    });
    await trashPath(h.deps, h.principal, "/made/b.txt");
    const [entry] = (await h.storage.trash.list()).entries;
    await restorePath(h.deps, h.principal, { id: entry?.id ?? "", target: "/made/back.txt" });
    expect(recorded.calls).toEqual([
      "mkdir /made",
      "move /a.txt",
      "copy /b.txt",
      "upload /made/text.txt",
      "upload /made/raw.bin",
      "upload /made/text.txt",
      "trash /made/b.txt",
      `restore ${entry?.id}`,
    ]);
  });
});

describe("MCP's personal activity", () => {
  it("is recorded the way the web's file routes record it, but for its source", async () => {
    const files = (activity: Activity) => testFileOperations({ activity: activity.service });
    const web = webHarness(files);
    await web.send("/api/v1/fs/mkdir", { json: { path: "/made" } });
    await web.send("/api/v1/fs/move", { json: { path: "/a.txt", target: "/made/a.txt" } });
    await web.send("/api/v1/fs/copy", { json: { path: "/b.txt", target: "/made/b.txt" } });
    await web.send("/api/v1/fs/upload?path=/made/new.txt&intent=create", {
      method: "PUT",
      body: "new",
    });
    await web.send("/api/v1/fs/delete", {
      json: { items: [{ path: "/made/b.txt", kind: "file" }] },
    });

    const mcp = mcpHarness(files);
    await runCreateFolder(mcp.deps, mcp.principal, { path: "/made" });
    await runMovePath(mcp.deps, mcp.principal, { src: "/a.txt", dst: "/made/a.txt" });
    await copyPath(mcp.deps, mcp.principal, { src: "/b.txt", dst: "/made/b.txt" });
    await createFile(mcp.deps, mcp.principal, { path: "/made/new.txt", text: "new" });
    await trashPath(mcp.deps, mcp.principal, "/made/b.txt");

    const facts = (activity: Activity) =>
      activity.operations.map((operation, index) => ({
        action: operation.action,
        requested: operation.requested,
        before: operation.before,
        after: activity.outcomes[index]?.after,
        outcome: activity.outcomes[index]?.outcome,
      }));
    expect(facts(mcp.activity)).toEqual(facts(web.activity));
    expect(mcp.activity.operations.map((operation) => operation.source)).toEqual(
      Array(5).fill("mcp"),
    );
    expect(web.activity.operations.map((operation) => operation.source)).toEqual(
      Array(5).fill("web"),
    );
    // Each MCP command keeps an operation ID of its own, unique within the request.
    expect(mcp.activity.operations.map((operation) => operation.producerOperationId)).toEqual([
      "mcp:0",
      "mcp:1",
      "mcp:2",
      "mcp:3",
      "mcp:4",
    ]);
  });
});
