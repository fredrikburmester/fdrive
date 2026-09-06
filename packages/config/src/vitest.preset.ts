import type { UserConfig } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Coverage thresholds enforced for a package. Every package starts from the
 * defaults below; a package may raise (or lower) any individual number by
 * passing its own thresholds through the overrides argument of
 * definePackageConfig.
 */
export interface CoverageThresholds {
  readonly functions: number;
  readonly lines: number;
  readonly branches: number;
  readonly statements: number;
}

export const DEFAULT_COVERAGE_THRESHOLDS: CoverageThresholds = {
  functions: 99,
  lines: 99,
  branches: 95,
  statements: 99,
};

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merges override onto base. Plain objects are merged key by
 * key so a caller can set a single nested field, such as
 * test.coverage.thresholds.functions, without repeating its siblings.
 * Arrays and primitives in override always replace the value in base.
 */
export function deepMerge<T extends PlainObject>(base: T, override: PlainObject): T {
  const result: PlainObject = { ...base };

  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    const baseValue = result[key];

    if (overrideValue === undefined) {
      continue;
    }

    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }

  return result as T;
}

function basePackageConfig(): UserConfig {
  return {
    test: {
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**", "test/integration/**"],
      coverage: {
        provider: "v8",
        include: ["src/**"],
        exclude: ["src/**/*.test.ts", "src/**/*.config.*", "src/**/*.d.ts", "src/**/index.ts"],
        reportsDirectory: "coverage",
        reporter: ["text", "lcov", "json-summary"],
        reportOnFailure: true,
        thresholds: { ...DEFAULT_COVERAGE_THRESHOLDS },
      },
    },
  };
}

/**
 * Builds the shared Vitest config used by every package in the workspace.
 * Pass overrides to change any field; nested objects (for example
 * test.coverage.thresholds) are deep-merged rather than replaced wholesale,
 * so a package can raise a single threshold, such as functions to 100,
 * without restating the rest.
 */
export function definePackageConfig(overrides: UserConfig = {}): UserConfig {
  const merged = deepMerge(
    basePackageConfig() as unknown as PlainObject,
    overrides as unknown as PlainObject,
  );
  return defineConfig(merged as UserConfig);
}
