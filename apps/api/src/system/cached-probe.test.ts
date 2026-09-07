import { describe, expect, it, vi } from "vitest";
import { createCachedProbe } from "./cached-probe.js";

describe("createCachedProbe", () => {
  it("shares one in-flight call between concurrent callers", async () => {
    let resolve: (value: string) => void = () => undefined;
    const probe = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const cached = createCachedProbe(probe, { ttlMs: 1000, clock: () => 0 });
    const first = cached();
    const second = cached();
    expect(probe).toHaveBeenCalledTimes(1);
    resolve("ok");
    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("ok");
  });

  it("reuses a settled result until the ttl passes, then probes again", async () => {
    let time = 0;
    const probe = vi.fn(async () => `at ${time}`);
    const cached = createCachedProbe(probe, { ttlMs: 100, clock: () => time });
    await expect(cached()).resolves.toBe("at 0");
    time = 99;
    await expect(cached()).resolves.toBe("at 0");
    expect(probe).toHaveBeenCalledTimes(1);
    time = 100;
    await expect(cached()).resolves.toBe("at 100");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("does not cache a rejected probe, so the next caller retries", async () => {
    const probe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("up");
    const cached = createCachedProbe(probe, { ttlMs: 100, clock: () => 0 });
    await expect(cached()).rejects.toThrow("down");
    await expect(cached()).resolves.toBe("up");
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
