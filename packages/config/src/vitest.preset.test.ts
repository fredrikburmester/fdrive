import { describe, expect, it } from "vitest";
import { DEFAULT_COVERAGE_THRESHOLDS, deepMerge, definePackageConfig } from "./vitest.preset.js";

describe("deepMerge", () => {
  it("merges nested plain objects key by key", () => {
    const base = { a: 1, nested: { x: 1, y: 2 } };
    const result = deepMerge(base, { nested: { y: 9 } });

    expect(result).toEqual({ a: 1, nested: { x: 1, y: 9 } });
  });

  it("lets override replace arrays and primitives outright", () => {
    const base = { list: [1, 2, 3], value: "base" };
    const result = deepMerge(base, { list: [9], value: "override" });

    expect(result).toEqual({ list: [9], value: "override" });
  });

  it("ignores undefined override values and keeps the base value", () => {
    const base = { a: 1, b: 2 };
    const result = deepMerge(base, { a: undefined });

    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("does not mutate the base object", () => {
    const base = { nested: { x: 1 } };
    deepMerge(base, { nested: { x: 2 } });

    expect(base.nested.x).toBe(1);
  });
});

describe("definePackageConfig", () => {
  it("defaults to the standard coverage thresholds", () => {
    const config = definePackageConfig();

    expect(config.test?.coverage?.thresholds).toEqual(DEFAULT_COVERAGE_THRESHOLDS);
  });

  it("deep-merges a single threshold override without touching its siblings", () => {
    const config = definePackageConfig({
      test: {
        coverage: {
          thresholds: {
            functions: 100,
          },
        },
      },
    });

    expect(config.test?.coverage?.thresholds).toEqual({
      functions: 100,
      lines: 99,
      branches: 95,
      statements: 99,
    });
  });

  it("keeps the base include and exclude patterns when overrides are unrelated", () => {
    const config = definePackageConfig({
      test: {
        coverage: {
          thresholds: { lines: 100 },
        },
      },
    });

    expect(config.test?.include).toEqual(["src/**/*.test.ts", "test/**/*.test.ts"]);
    expect(config.test?.coverage?.include).toEqual(["src/**"]);
  });
});
