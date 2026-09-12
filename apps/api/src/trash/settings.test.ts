import { isDeepStrictEqual } from "node:util";
import type { TrashStrategy } from "@fdrive/contracts";
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
  let strategy: TrashStrategy = "native";
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
    strategyFor: async () => strategy,
  });
  return {
    service,
    values,
    switchProvider: () => (providerId = PROVIDER_B),
    setStrategy: (next: TrashStrategy) => (strategy = next),
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
      rulesConfirmed: false,
      strategy: "native",
    });
    expect(await service.pathForIdentity("identity-a")).toBeNull();

    const enabled = await service.update(PROVIDER_A, {
      ...initial,
      enabled: true,
      rulesConfirmed: true,
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
    await service.update(PROVIDER_A, { ...initial, enabled: true, rulesConfirmed: true });

    switchProvider();
    expect(await service.forIdentity("identity-a")).toMatchObject({
      providerId: PROVIDER_B,
      revision: 0,
      enabled: false,
      rulesConfirmed: false,
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

  it("stores the configuration without the strategy and reports the module's current one", async () => {
    const { service, values, setStrategy } = harness();
    setStrategy("move");
    const initial = await service.configuration(PROVIDER_A);
    expect(initial.strategy).toBe("move");
    // A provider that moves deletes itself needs no rule confirmation.
    const enabled = await service.update(PROVIDER_A, { ...initial, enabled: true });
    expect(enabled).toMatchObject({ enabled: true, rulesConfirmed: false, strategy: "move" });
    expect(values.get(`trash.configuration.${PROVIDER_A}`)).toEqual({
      providerId: PROVIDER_A,
      revision: 1,
      enabled: true,
      path: "/.trash",
      retentionHours: null,
      rulesConfirmed: false,
    });
    expect(await service.pathForIdentity("identity-a")).toBe("/.trash");

    // The strategy the client saw must still be the module's.
    await expect(
      service.update(PROVIDER_A, { ...enabled, strategy: "native", rulesConfirmed: true }),
    ).rejects.toMatchObject({ kind: "conflict" });

    // Native again: the stored row is enabled without confirmed rules, so it reads as off.
    setStrategy("native");
    expect(await service.configuration(PROVIDER_A)).toMatchObject({
      enabled: false,
      rulesConfirmed: false,
      strategy: "native",
      revision: 1,
    });
    expect(await service.pathForIdentity("identity-a")).toBeNull();
    setStrategy("none");
    await expect(
      service.update(PROVIDER_A, { ...enabled, revision: 1, strategy: "none" }),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("refuses an unreadable stored row and a lost compare-and-set race", async () => {
    const { service, values } = harness();
    values.set(`trash.configuration.${PROVIDER_A}`, { providerId: PROVIDER_B, garbage: true });
    await expect(service.configuration(PROVIDER_A)).rejects.toMatchObject({ kind: "internal" });

    // Another writer lands between the read and the compare-and-set.
    const raced = createTrashSettingsService({
      settings: { get: async () => null, compareAndSet: async () => false },
      identities: { get: async () => null },
      strategyFor: async () => "native",
    });
    const initial = await raced.configuration(PROVIDER_A);
    await expect(raced.update(PROVIDER_A, { ...initial, path: "/raced" })).rejects.toMatchObject({
      kind: "conflict",
    });
  });
});

it("disables a legacy overlong Trash path and permits repairing the stored row", async () => {
  const { service, values } = harness();
  const initial = await service.configuration(PROVIDER_A);
  const { strategy: _strategy, ...stored } = initial;
  values.set(`trash.configuration.${PROVIDER_A}`, {
    ...stored,
    enabled: true,
    rulesConfirmed: true,
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
