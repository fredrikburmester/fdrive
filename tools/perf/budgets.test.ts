import { expect, it } from "vitest";
import {
  allBudgetsPassed,
  evaluateBudgets,
  REQUIRED_SCENARIOS,
  type ScenarioResults,
  validMeasurement,
} from "./budgets.js";
import { toScenarioResult } from "./results.js";

function valid(): ScenarioResults {
  const results: ScenarioResults = {};
  for (const name of REQUIRED_SCENARIOS)
    results[name] = toScenarioResult(
      name,
      Array.from({ length: 200 }, () => 10),
      100,
      0,
      {
        warmupCount: 20,
        uniquePaths: 20,
        verifiedCount: name === "uploadSmallBurst" ? 200 : 10000,
        maxMounted: 100,
        expectedBytes: 512 * 1024 * 1024,
        completedBytes: Array.from({ length: 200 }, () => 512 * 1024 * 1024),
        bytesPerSecond: 100,
        wallTimeMs: 1000,
      },
    );
  return results;
}
it("requires every complete finite error-free metric", () => {
  expect(allBudgetsPassed(evaluateBudgets(valid()))).toBe(true);
  expect(allBudgetsPassed([])).toBe(false);
  expect(allBudgetsPassed(evaluateBudgets({}))).toBe(false);
  for (const name of REQUIRED_SCENARIOS) {
    const results = valid();
    delete results[name];
    expect(allBudgetsPassed(evaluateBudgets(results))).toBe(false);
    for (const value of [NaN, Infinity, -1, 0]) {
      const r = valid();
      const old = r[name];
      if (!old) throw Error();
      r[name] = { ...old, p95Ms: value };
      expect(allBudgetsPassed(evaluateBudgets(r))).toBe(false);
    }
    const old = valid()[name];
    if (!old) throw Error();
    for (const change of [{ errors: 1 }, { samplesMs: [] }, { samplesMs: [NaN] }])
      expect(validMeasurement(name, { ...old, ...change })).toBe(false);
  }
});
it("requires warmup, cold path uniqueness, verified uploads, bounded UI and full downloads", () => {
  const r = valid();
  for (const [name, change] of [
    ["list1k", { warmupCount: 0 }],
    ["search25k", { warmupCount: 0 }],
    ["list1kCold", { uniquePaths: 1 }],
    ["uploadSmallBurst", { verifiedCount: 199 }],
    ["uiList", { maxMounted: 10000 }],
    ["uiGrid", { verifiedCount: 1 }],
    ["downloadViaApi", { completedBytes: [1] }],
    ["downloadDirect", { bytesPerSecond: Infinity }],
    ["downloadDirect", { expectedBytes: 1 }],
  ] as const) {
    const old = r[name];
    if (!old) throw Error();
    expect(validMeasurement(name, { ...old, ...change })).toBe(false);
  }
  for (const [name, p95Ms] of [
    ["list1k", 100],
    ["list1kCold", 400],
    ["search25k", 300],
    ["uiList", 500],
    ["uiGrid", 500],
  ] as const) {
    const copy = valid();
    const old = copy[name];
    if (!old) throw Error();
    copy[name] = { ...old, p95Ms };
    expect(allBudgetsPassed(evaluateBudgets(copy))).toBe(false);
  }
  const upload = r.uploadSmallBurst;
  if (!upload) throw Error();
  r.uploadSmallBurst = { ...upload, wallTimeMs: Infinity };
  expect(allBudgetsPassed(evaluateBudgets(r))).toBe(false);
  const via = r.downloadViaApi;
  if (!via) throw Error();
  r.downloadViaApi = { ...via, bytesPerSecond: 89 };
  expect(evaluateBudgets(r).find((x) => x.scenario === "downloadViaApi")?.status).toBe("fail");
});

it("rejects missing/nonfinite counters and missing throughput baselines", () => {
  const r = valid();
  expect(validMeasurement("list10k", toScenarioResult("list10k", [10], 1, 0))).toBe(true);
  for (const name of ["list1k", "search25k", "list1kCold", "uiList", "downloadDirect"] as const) {
    const old = r[name];
    if (!old) throw Error();
    const copy = { ...old };
    delete copy.warmupCount;
    delete copy.uniquePaths;
    delete copy.maxMounted;
    expect(validMeasurement(name, copy)).toBe(false);
  }
  for (const name of ["list1k", "list1kCold", "uiGrid", "downloadDirect"] as const) {
    const old = r[name];
    if (!old) throw Error();
    expect(
      validMeasurement(name, {
        ...old,
        warmupCount: Infinity,
        uniquePaths: Infinity,
        maxMounted: Infinity,
      }),
    ).toBe(false);
  }
  const direct = r.downloadDirect;
  if (!direct) throw Error();
  const incomplete = { ...direct };
  delete incomplete.completedBytes;
  expect(validMeasurement("downloadDirect", incomplete)).toBe(false);
  const upload = r.uploadSmallBurst;
  if (!upload) throw Error();
  const missingWall = { ...upload };
  delete missingWall.wallTimeMs;
  r.uploadSmallBurst = missingWall;
  expect(allBudgetsPassed(evaluateBudgets(r))).toBe(false);
});
