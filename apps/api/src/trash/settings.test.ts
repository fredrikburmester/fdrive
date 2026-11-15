import { isDeepStrictEqual } from "node:util";
import type { Identity, SettingsRepo } from "@fdrive/db";
import { describe, expect, it } from "vitest";
import { createTrashSettingsService } from "./settings.js";

const PROVIDER_A = "123e4567-e89b-42d3-a456-426614174000";
const PROVIDER_B = "223e4567-e89b-42d3-a456-426614174000";

function harness() {
  const values = new Map<string, unknown>();
  const settings: Pick<SettingsRepo, "get" | "compareAndSet"> = {
    async get<T>(key: string) {
      return values.has(key) ? (values.get(key) as T) : null;
    },
    async compareAndSet(key, expected, value) {
      const current = values.has(key) ? values.get(key) : null;
      if (!isDeepStrictEqual(current, expected)) return false;
      values.set(key, value);
      return true;
    },
  };
  let providerId = PROVIDER_A;
  const identity = (): Identity => ({
    id: "323e4567-e89b-42d3-a456-426614174000",
    accountId: "423e4567-e89b-42d3-a456-426614174000",
    providerId,
    externalUsername: "alice",
    createdAt: new Date(),
    lastLoginAt: null,
  });
  const service = createTrashSettingsService({
    settings,
    identities: { get: async () => identity() },
  });
  return {
    service,
    values,
    switchProvider: () => (providerId = PROVIDER_B),
  };
}

describe("Trash settings service", () => {
  it("defaults disabled and applies updates immediately without an environment fallback", async () => {
    const { service } = harness();
    const initial = await service.configuration(PROVIDER_A);
    expect(initial).toEqual({
      providerId: PROVIDER_A,
      revision: 0,
      enabled: false,
      path: "/.trash",
      retentionHours: null,
    });
    expect(await service.pathForIdentity("identity-a")).toBeNull();

    const enabled = await service.update(PROVIDER_A, {
      ...initial,
      enabled: true,
      retentionHours: 72,
    });
    expect(enabled.revision).toBe(1);
    expect(await service.pathForIdentity("identity-a")).toBe("/.trash");

    await service.update(PROVIDER_A, { ...enabled, enabled: false });
    expect(await service.pathForIdentity("identity-a")).toBeNull();
  });

  it("isolates settings by immutable provider and rejects a stale provider update", async () => {
    const { service, switchProvider } = harness();
    const initial = await service.configuration(PROVIDER_A);
    await service.update(PROVIDER_A, { ...initial, enabled: true });

    switchProvider();
    expect(await service.forIdentity("identity-a")).toMatchObject({
      providerId: PROVIDER_B,
      revision: 0,
      enabled: false,
    });
    await expect(service.update(PROVIDER_B, { ...initial, revision: 0 })).rejects.toMatchObject({
      kind: "conflict",
    });
  });

  it("uses compare-and-set revision protection", async () => {
    const { service } = harness();
    const initial = await service.configuration(PROVIDER_A);
    await service.update(PROVIDER_A, { ...initial, path: "/deleted" });
    await expect(service.update(PROVIDER_A, { ...initial, path: "/old" })).rejects.toMatchObject({
      kind: "conflict",
    });
  });

  it("stores the configuration as the routes send it", async () => {
    const { service, values } = harness();
    const initial = await service.configuration(PROVIDER_A);
    const enabled = await service.update(PROVIDER_A, { ...initial, enabled: true });
    expect(enabled).toMatchObject({ enabled: true, revision: 1 });
    expect(values.get(`trash.configuration.${PROVIDER_A}`)).toEqual({
      providerId: PROVIDER_A,
      revision: 1,
      enabled: true,
      path: "/.trash",
      retentionHours: null,
    });
    expect(await service.pathForIdentity("identity-a")).toBe("/.trash");
    await expect(
      service.update(PROVIDER_A, { ...enabled, retentionHours: 0 }),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("reads the stored row once, and serves what it saved without reading again", async () => {
    const { service, values } = harness();
    const key = `trash.configuration.${PROVIDER_A}`;
    const initial = await service.configuration(PROVIDER_A);
    // Nothing but this service writes the row; a write behind its back is not seen.
    values.set(key, { ...initial, enabled: true, revision: 5 });
    expect(await service.configuration(PROVIDER_A)).toEqual(initial);
    // Saving reads the row itself, so a stale cache cannot win a compare-and-set.
    await expect(service.update(PROVIDER_A, { ...initial, enabled: true })).rejects.toMatchObject({
      kind: "conflict",
    });
    expect(await service.configuration(PROVIDER_A)).toMatchObject({ revision: 5, enabled: true });
    const saved = await service.update(PROVIDER_A, {
      ...initial,
      revision: 5,
      path: "/deleted",
    });
    values.delete(key);
    expect(await service.configuration(PROVIDER_A)).toEqual(saved);
    expect(await service.pathForIdentity("identity-a")).toBeNull();
  });

  it("refuses an unreadable stored row and a lost compare-and-set race", async () => {
    const { service, values } = harness();
    values.set(`trash.configuration.${PROVIDER_A}`, { providerId: PROVIDER_B, garbage: true });
    await expect(service.configuration(PROVIDER_A)).rejects.toMatchObject({ kind: "internal" });

    // Another writer lands between the read and the compare-and-set.
    const raced = createTrashSettingsService({
      settings: { get: async () => null, compareAndSet: async () => false },
      identities: { get: async () => null },
    });
    const initial = await raced.configuration(PROVIDER_A);
    await expect(raced.update(PROVIDER_A, { ...initial, path: "/raced" })).rejects.toMatchObject({
      kind: "conflict",
    });
  });
});

it("disables a legacy overlong Trash path and permits repairing the stored row", async () => {
  const { service, values } = harness();
  values.set(`trash.configuration.${PROVIDER_A}`, {
    providerId: PROVIDER_A,
    retentionHours: null,
    enabled: true,
    path: `/${"é".repeat(128)}`,
    revision: 3,
  });
  expect(await service.pathForIdentity("identity-a")).toBeNull();
  const recovered = await service.configuration(PROVIDER_A);
  expect(recovered).toMatchObject({ enabled: false, path: "/.trash", revision: 3 });
  await expect(
    service.update(PROVIDER_A, { ...recovered, path: "/recovered" }),
  ).resolves.toMatchObject({ revision: 4, path: "/recovered" });
});

it("reads a row an older version saved with keys it no longer stores, and saves it without them", async () => {
  const { service, values } = harness();
  const key = `trash.configuration.${PROVIDER_A}`;
  values.set(key, {
    providerId: PROVIDER_A,
    revision: 2,
    enabled: true,
    path: "/.trash",
    retentionHours: null,
    rulesConfirmed: false,
  });

  const current = await service.configuration(PROVIDER_A);
  expect(current).toEqual({
    providerId: PROVIDER_A,
    revision: 2,
    enabled: true,
    path: "/.trash",
    retentionHours: null,
  });
  expect(await service.pathForIdentity("identity-a")).toBe("/.trash");

  await service.update(PROVIDER_A, { ...current, retentionHours: 24 });
  expect(values.get(key)).toEqual({
    providerId: PROVIDER_A,
    revision: 3,
    enabled: true,
    path: "/.trash",
    retentionHours: 24,
  });
});
