import type { SettingsRepo } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { createTrashSettingsService } from "./settings.js";

function harness(initial?: unknown) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set("trash.retentionDays", initial);
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const settings = {
    get: get as SettingsRepo["get"],
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
  const record = vi.fn();
  return {
    service: createTrashSettingsService({ settings, eventLog: { record } }),
    get,
    values,
    record,
  };
}

describe("Trash settings service", () => {
  it("keeps items 30 days until an administrator changes it, and reads the row once", async () => {
    const h = harness();
    expect(await h.service.current()).toEqual({ retentionDays: 30 });
    expect(await h.service.current()).toEqual({ retentionDays: 30 });
    expect(h.get).toHaveBeenCalledOnce();

    expect(await h.service.update({ retentionDays: 1 })).toEqual({ retentionDays: 1 });
    expect(h.values.get("trash.retentionDays")).toEqual({ retentionDays: 1 });
    expect(await h.service.current()).toEqual({ retentionDays: 1 });
    expect(h.get).toHaveBeenCalledOnce();
    expect(h.record).toHaveBeenCalledWith("general", "info", "Trash keeps items for 1 day");
  });

  it("reads a saved value and refuses an invalid one", async () => {
    expect(await harness({ retentionDays: 90 }).service.current()).toEqual({ retentionDays: 90 });
    await expect(harness({ retentionDays: 0 }).service.current()).rejects.toThrow();
    const h = harness();
    await expect(h.service.update({ retentionDays: 0 })).rejects.toThrow();
    expect(h.values.size).toBe(0);
  });
});
