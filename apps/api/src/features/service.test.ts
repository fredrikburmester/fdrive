import { FEATURES_SETTINGS_KEY, type FeatureConfiguration } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import { type AppConfig, loadConfig } from "../config.js";
import type { SystemEventLog } from "../system/event-log.js";
import {
  createFeatureService,
  DISABLED_FEATURES,
  FEATURE_LOG_SUBSYSTEMS,
  type FeatureSettingsStore,
} from "./service.js";

interface Recorded {
  subsystem: string;
  level: string;
  message: string;
}

function recorder(): { eventLog: SystemEventLog; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    recorded,
    eventLog: {
      record: (subsystem, level, message) => {
        recorded.push({ subsystem, level, message });
      },
    },
  };
}

const base = loadConfig({
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
});
const full: AppConfig = {
  ...base,
  fdriveIndexRoots: [{ name: "sftpgo", sftpgoPath: "/data", indexerPath: "/roots/sftpgo" }],
  fdriveIndexerUrl: "http://indexer",
  fdriveEmbedUrl: "http://embed",
  fdriveImageEmbedUrl: "http://image",
  fdriveOcrUrl: "http://ocr",
  fdriveThumbsDir: "/thumbs",
};
const enabled = {
  ...DISABLED_FEATURES,
  thumbnails: true,
  textSearch: true,
  searchOcr: true,
  semanticSearch: true,
  imageSearch: true,
  pdfOcr: true,
};
const config: FeatureConfiguration = {
  version: 1,
  revision: 1,
  values: enabled,
  walkthroughComplete: false,
};

function fixture(
  options: {
    config?: AppConfig;
    raw?: unknown;
    fetch?: typeof fetch;
    rejectCas?: boolean;
    eventLog?: SystemEventLog;
  } = {},
) {
  let raw: unknown | null = options.raw ?? null;
  const settings: FeatureSettingsStore = {
    get: async <T>(key: string) => {
      expect(key).toBe(FEATURES_SETTINGS_KEY);
      return raw as T | null;
    },
    compareAndSet: async (_key, expected, value) => {
      if (options.rejectCas || JSON.stringify(raw) !== JSON.stringify(expected)) return false;
      raw = value;
      return true;
    },
  };
  const fetchImpl =
    options.fetch ??
    (vi.fn(async () =>
      Response.json({ ok: true, status: "ok", features: { revision: 1, values: enabled } }),
    ) as typeof fetch);
  return {
    service: createFeatureService({
      settings,
      config: options.config ?? full,
      fetch: fetchImpl,
      ...(options.eventLog === undefined ? {} : { eventLog: options.eventLog }),
    }),
    fetchImpl,
  };
}

describe("feature configuration", () => {
  it("starts unconfigured installations off and only checks configured storage workers", async () => {
    const { service, fetchImpl } = fixture();
    expect(await service.configuration()).toMatchObject({
      revision: 0,
      values: DISABLED_FEATURES,
      walkthroughComplete: false,
    });
    expect(await service.enabled("pdfOcr")).toBe(false);
    expect((await service.status()).source).toBe("default");
    expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
      "http://indexer/health",
      "http://ocr/health",
    ]);
  });
  it("persists progress and rejects racing/stale writes", async () => {
    const { service } = fixture();
    const input = { revision: 0, values: enabled, walkthroughComplete: false, walkthroughStep: 3 };
    const results = await Promise.allSettled([service.update(input), service.update(input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await service.configuration()).toMatchObject({ revision: 1, walkthroughStep: 3 });
    await expect(service.update(input)).rejects.toMatchObject({ kind: "conflict" });
    expect(await service.enabled("pdfOcr")).toBe(true);
    const updated = await service.update({
      revision: 1,
      values: DISABLED_FEATURES,
      walkthroughComplete: true,
    });
    expect(updated).toMatchObject({
      revision: 2,
      walkthroughComplete: true,
      values: DISABLED_FEATURES,
    });
  });
  it("does not overwrite a competing update or corrupt settings", async () => {
    await expect(
      fixture({ rejectCas: true }).service.update({
        revision: 0,
        values: enabled,
        walkthroughComplete: true,
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(fixture({ raw: { version: 99 } }).service.configuration()).rejects.toMatchObject({
      kind: "internal",
    });
  });
});

describe("observed feature status", () => {
  it("reports ready only after workers acknowledge the revision", async () => {
    const { service } = fixture({ raw: config });
    const status = await service.status();
    expect(status.source).toBe("settings");
    expect(status.statuses.every((s) => s.state === "ready")).toBe(true);
  });
  it.each(["loading", "preparing", "starting", "off", "stopping"])(
    "keeps %s separate from ready",
    async (status) => {
      const result = await fixture({
        raw: config,
        fetch: async () => Response.json({ status, features: { revision: 1 } }),
      }).service.status();
      expect(result.statuses.every((s) => s.state === "preparing")).toBe(true);
    },
  );
  it("keeps unapplied revisions preparing", async () => {
    const result = await fixture({
      raw: config,
      fetch: async () => Response.json({ ok: true, revision: 0 }),
    }).service.status();
    expect(result.statuses.every((s) => s.state === "preparing")).toBe(true);
  });
  it.each(["failed", "error"])("surfaces explicit %s preparation failure", async (status) => {
    const result = await fixture({
      raw: config,
      fetch: async () => Response.json({ status }),
    }).service.status();
    expect(result.statuses.every((s) => s.state === "failed")).toBe(true);
  });
  it("blocks local processing without configured roots", async () => {
    const result = await fixture({ raw: config, config: base }).service.status();
    expect(result.statuses.every((s) => s.state === "blocked")).toBe(true);
  });
  it("surfaces missing workers, HTTP errors, schema failure and network failures", async () => {
    for (const opts of [
      {
        config: {
          ...full,
          fdriveIndexerUrl: undefined,
          fdriveOcrUrl: undefined,
          fdriveEmbedUrl: undefined,
          fdriveImageEmbedUrl: undefined,
        },
      },
      { fetch: async () => new Response("", { status: 503 }) },
      { fetch: async () => Response.json({ ok: false }) },
      {
        fetch: async () => {
          throw new Error("private upstream detail");
        },
      },
    ]) {
      const result = await fixture({ raw: config, ...opts }).service.status();
      expect(result.statuses.every((s) => s.state === "failed")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private upstream detail");
    }
  });
  it("does not accept liveness without configuration acknowledgment", async () => {
    const result = await fixture({
      raw: config,
      fetch: async () => Response.json(null),
    }).service.status();
    expect(result.statuses.every((s) => s.state === "preparing")).toBe(true);
  });
  it("reports stopping until a running OCR pass finishes", async () => {
    const result = await fixture({
      raw: { ...config, values: DISABLED_FEATURES },
      fetch: async () =>
        Response.json({ ok: true, running: true, features: { revision: 0, values: enabled } }),
    }).service.status();
    expect(result.statuses.every((s) => s.state === "stopping")).toBe(true);
  });
  it("blocks inaccessible mounts independently from worker liveness", async () => {
    const result = await fixture({
      raw: config,
      fetch: async () =>
        Response.json({
          ok: true,
          storage: { sftpgo: { readable: false, writable: false } },
          features: { revision: 1 },
        }),
    }).service.status();
    expect(result.statuses.every((s) => s.state === "blocked")).toBe(true);
    const ready = await fixture({
      raw: config,
      fetch: async () =>
        Response.json({
          ok: true,
          storage: { sftpgo: { readable: true, writable: true } },
          features: { revision: 1, status: "ok" },
        }),
    }).service.status();
    expect(ready.statuses.every((s) => s.state === "ready")).toBe(true);
  });
  it("shows read-only storage diagnostics before any feature is selected", async () => {
    const result = await fixture({
      fetch: async () =>
        Response.json({
          ok: true,
          storage: { sftpgo: { readable: true, writable: false } },
          features: { revision: 0, values: DISABLED_FEATURES },
        }),
    }).service.status();
    expect(result.roots[0]?.processing).toEqual({
      indexReadable: true,
      pdfReadable: true,
      pdfWritable: false,
    });
    expect(result.statuses.every((s) => s.state === "off")).toBe(true);
  });
});

describe("feature event log", () => {
  it("records one entry per changed value, in the feature's own subsystem", async () => {
    const { eventLog, recorded } = recorder();
    const { service } = fixture({ eventLog });

    await service.update({
      revision: 0,
      values: { ...DISABLED_FEATURES, thumbnails: true, pdfOcr: true },
      walkthroughComplete: false,
    });
    await service.update({
      revision: 1,
      values: { ...DISABLED_FEATURES, thumbnails: true },
      walkthroughComplete: false,
    });

    expect(recorded).toEqual([
      { subsystem: "indexer", level: "info", message: "Feature thumbnails enabled" },
      { subsystem: "ocr", level: "info", message: "Feature pdfOcr enabled" },
      { subsystem: "ocr", level: "info", message: "Feature pdfOcr disabled" },
    ]);
  });

  it("records nothing when only the walkthrough moved", async () => {
    const { eventLog, recorded } = recorder();
    const { service } = fixture({ eventLog });

    await service.update({
      revision: 0,
      values: DISABLED_FEATURES,
      walkthroughComplete: true,
      walkthroughStep: 2,
    });

    expect(recorded).toEqual([]);
  });

  it("maps every feature to a subsystem that has a log", () => {
    expect(Object.values(FEATURE_LOG_SUBSYSTEMS).sort()).toEqual([
      "image-search",
      "indexer",
      "indexer",
      "indexer",
      "ocr",
      "search",
    ]);
  });

  it("records only worker probe transitions, not every poll", async () => {
    const { eventLog, recorded } = recorder();
    let up = true;
    const { service } = fixture({
      eventLog,
      raw: config,
      fetch: (async () =>
        up
          ? Response.json({ ok: true, status: "ok", features: { revision: 1, values: enabled } })
          : new Response("nope", { status: 503 })) as typeof fetch,
    });

    await service.status();
    expect(recorded).toEqual([]);

    up = false;
    await service.status();
    await service.status();
    const down = recorded.filter((entry) => entry.level === "error");
    expect(down).toHaveLength(4);
    expect(new Set(down.map((entry) => entry.subsystem))).toEqual(
      new Set(["indexer", "ocr", "search", "image-search"]),
    );
    expect(down[0]?.message).toBe(
      "Worker unreachable: Worker is unavailable. Retry after checking its status.",
    );

    up = true;
    recorded.length = 0;
    await service.status();
    await service.status();
    expect(recorded).toHaveLength(4);
    expect(recorded.every((entry) => entry.message === "Worker reachable again")).toBe(true);
  });

  it("reports a worker that is already down on the first observation", async () => {
    const { eventLog, recorded } = recorder();
    const { service } = fixture({
      eventLog,
      raw: config,
      fetch: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    });

    await service.status();

    expect(recorded).toHaveLength(4);
    expect(recorded[0]).toEqual({
      subsystem: "indexer",
      level: "error",
      message: "Worker unreachable: Worker is unreachable. Check the bundled service, then retry.",
    });
  });
});
