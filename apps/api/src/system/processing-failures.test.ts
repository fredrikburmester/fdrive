import type { ProcessingFailureReader } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { registerProcessingFailureRoutes } from "./processing-failures.js";

const empty = { entries: [], groups: [], total: 0, openCount: 0 };
function fixture(admin = true, indexerUrl: string | undefined = "http://indexer") {
  const read = vi.fn<ProcessingFailureReader>(async () => empty);
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ started: true, operationId: "retry-1" }),
  );
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
    registerRoutes: (groups) =>
      registerProcessingFailureRoutes(groups, { read, fetch, indexerUrl }),
  });
  const retry = (body = "{}", feature = "thumbnails") =>
    app.request(`/api/v1/system/processing-failures/${feature}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-requested-with": "fdrive" },
      body,
    });
  return { app, read, fetch, retry };
}

describe("processing failures", () => {
  it("authorizes before accessing files or workers", async () => {
    const { app, read, fetch, retry } = fixture(false);
    expect((await app.request("/api/v1/system/processing-failures/thumbnails")).status).toBe(403);
    expect((await retry()).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads durable history without probing the worker and validates filters", async () => {
    const { app, read, fetch } = fixture();
    const result = await app.request(
      "/api/v1/system/processing-failures/thumbnails?status=resolved&before=9&limit=2&code=DecodeError",
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(empty);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(read).toHaveBeenCalledWith("thumbnails", {
      status: "resolved",
      before: 9,
      limit: 2,
      code: "DecodeError",
    });
    expect(fetch).not.toHaveBeenCalled();
    for (const suffix of [
      "unknown",
      "thumbnails?limit=0",
      "thumbnails?status=all",
      "thumbnails?before=-1",
    ]) {
      expect((await app.request(`/api/v1/system/processing-failures/${suffix}`)).status).toBe(400);
    }
  });
  it("retries one file or the unresolved inventory", async () => {
    const { retry, fetch } = fixture();
    expect((await retry('{"id":3}')).status).toBe(202);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      feature: "thumbnails",
      id: 3,
    });
    expect((await retry()).status).toBe(202);
    for (const body of ["bad json", '{"id":0}', '{"path":"/arbitrary"}'])
      expect((await retry(body)).status).toBe(400);
    expect((await retry("{}", "unknown")).status).toBe(400);
  });
  it.each([409, 404, 503])(
    "reports worker rejection %s without pretending to start",
    async (status) => {
      const { retry, fetch } = fixture();
      fetch.mockResolvedValue(Response.json({ error: "unavailable" }, { status }));
      expect((await retry()).status).toBe(status === 503 ? 502 : status);
    },
  );
  it("reports missing configuration", async () => {
    const { app } = fixture(true, "");
    expect(
      (
        await app.request("/api/v1/system/processing-failures/thumbnails/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-requested-with": "fdrive" },
          body: "{}",
        })
      ).status,
    ).toBe(502);
  });
});
