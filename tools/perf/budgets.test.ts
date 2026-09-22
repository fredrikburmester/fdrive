import { expect, it } from "vitest";
import {
  allBudgetsPassed,
  evaluateBudgets,
  REQUIRED_SCENARIOS,
  type ScenarioName,
  type ScenarioResults,
  validMeasurement,
} from "./budgets.js";
import { toScenarioResult } from "./results.js";

function resultWithSamples(name: ScenarioName, samples: number) {
  return toScenarioResult(
    name,
    Array.from({ length: samples }, () => 10),
    100,
    0,
    {
      warmupCount: 20,
      uniquePaths: 20,
      verifiedCount: name === "uploadSmallBurst" ? 200 : 10000,
      maxMounted: 100,
      expectedBytes: 512 * 1024 * 1024,
      completedBytes: Array.from({ length: samples }, () => 512 * 1024 * 1024),
      bytesPerSecond: 100,
      wallTimeMs: 1000,
    },
  );
}

function valid(): ScenarioResults {
  const results: ScenarioResults = {};
  for (const name of REQUIRED_SCENARIOS) results[name] = resultWithSamples(name, 200);
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
it("pins each scenario's minimum sample count", () => {
  // The floors from budgets.ts: a result at the floor is a valid measurement
  // and one sample below it is not. Lowering a floor (or raising it past the
  // current value) fails this test instead of silently relaxing the gate.
  const floors = [
    ["list1kCold", 20],
    ["list1k", 100],
    ["uiList", 5],
    ["uiGrid", 5],
    ["search25k", 100],
    ["downloadViaApi", 3],
    ["downloadDirect", 3],
    ["uploadSmallBurst", 200],
  ] as const;

  for (const [name, floor] of floors) {
    expect(validMeasurement(name, resultWithSamples(name, floor)), `${name} at ${floor}`).toBe(
      true,
    );
    expect(
      validMeasurement(name, resultWithSamples(name, floor - 1)),
      `${name} one below ${floor}`,
    ).toBe(false);
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
