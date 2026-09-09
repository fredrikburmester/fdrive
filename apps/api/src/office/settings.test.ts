import { isDeepStrictEqual } from "node:util";
import type { SettingsRepo } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { createOfficeSettingsService, probeOnlyOfficeRuntime } from "./settings.js";

const PROVIDER_A = "123e4567-e89b-42d3-a456-426614174000";
const PROVIDER_B = "223e4567-e89b-42d3-a456-426614174000";

function harness(
  options: {
    product?: "onlyoffice" | "collabora";
    status?: "starting" | "ready" | "unavailable";
    failProbe?: boolean;
    publicUrl?: string | null;
  } = {},
) {
  const recorded: { subsystem: string; level: string; message: string; data: unknown }[] = [];
  let stored: unknown | null = null;
  let rejectCas = false;
  const settings: Pick<SettingsRepo, "get" | "compareAndSet"> = {
    async get<T>() {
      return stored as T | null;
    },
    async compareAndSet(_key, expected, value) {
      if (rejectCas || !isDeepStrictEqual(stored, expected)) return false;
      stored = value;
      return true;
    },
  };
  const probeStatus = vi.fn(async (): Promise<"starting" | "ready" | "unavailable"> => {
    if (options.failProbe) throw new Error("private runtime failure");
    return options.status ?? "ready";
  });
  const service = createOfficeSettingsService({
    settings,
    product: options.product ?? "onlyoffice",
    publicUrl: async () =>
      options.publicUrl === undefined ? "https://drive.example" : options.publicUrl,
    probeStatus,
    eventLog: {
      record: (subsystem, level, message, data) => {
        recorded.push({ subsystem, level, message, data });
      },
    },
  });
  return {
    service,
    probeStatus,
    recorded,
    setStored: (value: unknown) => {
      stored = value;
    },
    rejectCas: () => {
      rejectCas = true;
    },
  };
}

describe("Office settings service", () => {
  it("defaults off and activates only from persisted settings", async () => {
    const { service, probeStatus } = harness();
    const initial = await service.configuration();
    expect(initial).toEqual({
      revision: 0,
      enabled: false,
      editingEnabled: false,
      editingProviderId: null,
      editorUsernames: [],
    });
    expect(await service.runtimeConfiguration()).toEqual({
      version: 1,
      revision: 0,
      enabled: false,
    });
    expect(await service.status(PROVIDER_A)).toMatchObject({
      configuration: initial,
      product: "onlyoffice",
      status: "off",
      activeProviderId: PROVIDER_A,
    });
    expect(probeStatus).not.toHaveBeenCalled();

    const updated = await service.update(PROVIDER_A, {
      ...initial,
      enabled: true,
      editingEnabled: true,
      editingProviderId: PROVIDER_A,
      editorUsernames: ["alice"],
    });
    expect(updated).toMatchObject({ revision: 1, enabled: true });
    expect(await service.runtimeConfiguration()).toEqual({
      version: 1,
      revision: 1,
      enabled: true,
    });
    expect(await service.status(PROVIDER_A)).toMatchObject({ status: "ready" });
  });

  it("binds editing to the active provider and protects revisions", async () => {
    const { service } = harness();
    const initial = await service.configuration();
    await expect(
      service.update(PROVIDER_B, {
        ...initial,
        enabled: true,
        editingEnabled: true,
        editingProviderId: PROVIDER_A,
        editorUsernames: ["alice"],
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
    const enabled = await service.update(PROVIDER_A, {
      ...initial,
      enabled: true,
      editingEnabled: true,
      editingProviderId: PROVIDER_A,
      editorUsernames: ["alice"],
    });
    await expect(service.update(PROVIDER_B, { ...enabled, enabled: false })).resolves.toMatchObject(
      { enabled: false, revision: 2 },
    );
    await expect(
      service.update(PROVIDER_A, { ...initial, editorUsernames: [] }),
    ).rejects.toMatchObject({ kind: "conflict" });
  });

  it("refuses to enable Office until the server address is set", async () => {
    const { service } = harness({ publicUrl: null });
    const initial = await service.configuration();
    await expect(service.update(PROVIDER_A, { ...initial, enabled: true })).rejects.toMatchObject({
      kind: "bad_request",
    });
    await expect(service.update(PROVIDER_A, initial)).resolves.toMatchObject({ revision: 1 });
  });

  it("does not activate the bundled controller for Collabora", async () => {
    const { service } = harness({ product: "collabora", status: "unavailable" });
    const initial = await service.configuration();
    await service.update(PROVIDER_A, {
      ...initial,
      enabled: true,
    });
    expect(await service.runtimeConfiguration()).toMatchObject({ revision: 1, enabled: false });
    expect(await service.status(null)).toMatchObject({
      product: "collabora",
      status: "unavailable",
      activeProviderId: null,
    });
  });

  it("reports an enabled runtime that has not reached its revision as starting", async () => {
    const { service } = harness({ status: "starting" });
    const initial = await service.configuration();
    await service.update(PROVIDER_A, {
      ...initial,
      enabled: true,
    });
    expect(await service.status(PROVIDER_A)).toMatchObject({ status: "starting" });
  });

  it("fails closed for corrupt storage, racing writes and private probe failures", async () => {
    const corrupt = harness();
    corrupt.setStored({ revision: "bad" });
    await expect(corrupt.service.configuration()).rejects.toMatchObject({ kind: "internal" });

    const racing = harness();
    const initial = await racing.service.configuration();
    racing.rejectCas();
    await expect(racing.service.update(PROVIDER_A, initial)).rejects.toMatchObject({
      kind: "conflict",
    });

    const failing = harness({ failProbe: true });
    const disabled = await failing.service.configuration();
    await failing.service.update(PROVIDER_A, {
      ...disabled,
      enabled: true,
    });
    expect(await failing.service.status(PROVIDER_A)).toMatchObject({ status: "unavailable" });
  });
});

describe("ONLYOFFICE runtime status", () => {
  it.each([
    [{ status: "ready", revision: 4 }, 200, "ready"],
    [{ status: "ready", revision: 3 }, 200, "starting"],
    [{ status: "starting", revision: 4 }, 200, "starting"],
    [{ status: "failed", revision: 4 }, 200, "unavailable"],
    [{ status: "ready", revision: 4 }, 503, "unavailable"],
  ] as const)("maps %j at HTTP %s to %s", async (body, status, expected) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
    expect(await probeOnlyOfficeRuntime("http://onlyoffice/old?x=1#x", 4, fetchImpl)).toBe(
      expected,
    );
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://onlyoffice:8099/runtime");
  });
});

describe("Office settings event log", () => {
  it("records an entry only once the write actually lands", async () => {
    const { service, recorded, rejectCas } = harness();

    await service.update(PROVIDER_A, {
      revision: 0,
      enabled: true,
      editingEnabled: true,
      editingProviderId: PROVIDER_A,
      editorUsernames: ["alice"],
    });

    expect(recorded).toEqual([
      {
        subsystem: "office",
        level: "info",
        message: "Office settings updated",
        data: { enabled: true, editingEnabled: true },
      },
    ]);

    rejectCas();
    await expect(
      service.update(PROVIDER_A, {
        revision: 1,
        enabled: false,
        editingEnabled: false,
        editingProviderId: null,
        editorUsernames: [],
      }),
    ).rejects.toThrow();
    expect(recorded).toHaveLength(1);
  });
});
