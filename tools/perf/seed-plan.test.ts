import { describe, expect, it } from "vitest";
import { buildFlatSeedPlan, PERF_USER, paddingWidth } from "./seed-plan.js";

describe("paddingWidth", () => {
  it("is 1 for a count of 0 or 1", () => {
    expect(paddingWidth(0)).toBe(1);
    expect(paddingWidth(1)).toBe(1);
  });

  it("is 3 for 1000 items (indices 0..999)", () => {
    expect(paddingWidth(1000)).toBe(3);
  });

  it("is 4 for 10000 items (indices 0..9999)", () => {
    expect(paddingWidth(10000)).toBe(4);
  });

  it("is 2 for 10 items (indices 0..9, widest is 9)", () => {
    expect(paddingWidth(10)).toBe(1);
  });
});

describe("buildFlatSeedPlan", () => {
  it("builds one entry per file, all the requested size", () => {
    const plan = buildFlatSeedPlan("/flat-1k", 5, 1024);
    expect(plan).toHaveLength(5);
    for (const entry of plan) {
      expect(entry.sizeBytes).toBe(1024);
    }
  });

  it("zero pads every name to the same width", () => {
    const plan = buildFlatSeedPlan("/flat-1k", 1000, 1024);
    expect(plan[0]?.path).toBe("/flat-1k/000.bin");
    expect(plan[9]?.path).toBe("/flat-1k/009.bin");
    expect(plan[999]?.path).toBe("/flat-1k/999.bin");
    for (const entry of plan) {
      // "/flat-1k/" (9 chars) + 3 digit name + ".bin" (4 chars).
      expect(entry.path.length).toBe(9 + 3 + 4);
    }
  });

  it("produces unique paths", () => {
    const plan = buildFlatSeedPlan("/flat-10k", 10_000, 256);
    const unique = new Set(plan.map((entry) => entry.path));
    expect(unique.size).toBe(10_000);
  });

  it("is deterministic", () => {
    const a = buildFlatSeedPlan("/flat-1k", 1000, 1024);
    const b = buildFlatSeedPlan("/flat-1k", 1000, 1024);
    expect(a).toEqual(b);
  });

  it("returns an empty plan for a count of 0", () => {
    expect(buildFlatSeedPlan("/empty", 0, 1)).toEqual([]);
  });
});

describe("PERF_USER", () => {
  it("has full permissions on its home directory", () => {
    expect(PERF_USER.username).toBe("perf");
    expect(PERF_USER.password).toBe("perf-password");
    expect(PERF_USER.permissions["/"]).toEqual(["*"]);
  });
});
