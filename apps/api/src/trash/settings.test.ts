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
  return { service, values, switchProvider: () => (providerId = PROVIDER_B) };
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
});
