import { isDeepStrictEqual } from "node:util";
import type { SettingsRepo } from "@fdrive/db";
import { describe, expect, it } from "vitest";
import { createPublicUrlService } from "./public-url.js";

function harness(options: { stored?: unknown } = {}) {
  let stored: unknown | null = options.stored ?? null;
  const settings: Pick<SettingsRepo, "get" | "compareAndSet"> = {
    async get<T>() {
      return stored as T | null;
    },
    async compareAndSet(_key, expected, value) {
      if (!isDeepStrictEqual(stored, expected)) return false;
      stored = value;
      return true;
    },
  };
  const service = createPublicUrlService({ settings });
  return {
    service,
    setStored: (value: unknown) => {
      stored = value;
    },
  };
}

describe("public URL service", () => {
  it("is unset until saved, then normalises and bumps the revision", async () => {
    const { service } = harness();
    expect(await service.configuration()).toEqual({ revision: 0, url: null });
    expect(await service.current()).toBeNull();
    const saved = await service.update({ revision: 0, url: "https://drive.example/" });
    expect(saved).toEqual({ revision: 1, url: "https://drive.example" });
    expect(await service.current()).toBe("https://drive.example");
    expect(await service.update({ revision: 1, url: null })).toEqual({ revision: 2, url: null });
  });

  it("rejects stale revisions and lost compare-and-set races as conflicts", async () => {
    const { service, setStored } = harness();
    await service.update({ revision: 0, url: "https://drive.example" });
    await expect(service.update({ revision: 0, url: null })).rejects.toMatchObject({
      kind: "conflict",
    });
    setStored({ revision: 1, url: "https://other.example" });
    await expect(
      service.update({ revision: 1, url: "https://drive.example" }),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it("reports a corrupt stored row instead of silently resetting it", async () => {
    const { service } = harness({ stored: { revision: "x" } });
    await expect(service.current()).rejects.toMatchObject({ kind: "internal" });
  });
});
