import { describe, expect, it } from "vitest";
import { allBudgetsPassed, evaluateBudgets, type ScenarioResults } from "./budgets.js";
import type { ScenarioResult } from "./results.js";

function result(overrides: Partial<ScenarioResult> & { name: string }): ScenarioResult {
  return {
    p50Ms: 1,
    p95Ms: 1,
    p99Ms: 1,
    requestsPerSecond: 1,
    errors: 0,
    ...overrides,
  };
}

describe("evaluateBudgets", () => {
  it("passes list1k when warm p95 is under 100 ms", () => {
    const results: ScenarioResults = { list1k: result({ name: "list1k", p95Ms: 42 }) };
    const outcomes = evaluateBudgets(results);
    const list1k = outcomes.find((o) => o.scenario === "list1k");
    expect(list1k?.status).toBe("pass");
  });

  it("fails list1k when warm p95 is at or over 100 ms", () => {
    const results: ScenarioResults = { list1k: result({ name: "list1k", p95Ms: 100 }) };
    const outcomes = evaluateBudgets(results);
    const list1k = outcomes.find((o) => o.scenario === "list1k");
    expect(list1k?.status).toBe("fail");
  });

  it("skips list1k when it was not run", () => {
    const outcomes = evaluateBudgets({});
    const list1k = outcomes.find((o) => o.scenario === "list1k");
    expect(list1k?.status).toBe("skipped");
  });

  it("passes list1kCold under 400 ms and fails at or over", () => {
    const under = evaluateBudgets({ list1kCold: result({ name: "list1kCold", p95Ms: 399 }) });
    const over = evaluateBudgets({ list1kCold: result({ name: "list1kCold", p95Ms: 400 }) });
    expect(under.find((o) => o.scenario === "list1kCold")?.status).toBe("pass");
    expect(over.find((o) => o.scenario === "list1kCold")?.status).toBe("fail");
  });

  it("reports list10k as informational, never pass or fail", () => {
    const outcomes = evaluateBudgets({
      list10k: result({ name: "list10k", p95Ms: 5000 }),
    });
    const list10k = outcomes.find((o) => o.scenario === "list10k");
    expect(list10k?.status).toBe("informational");
  });

  it("passes the download ratio budget at exactly 90%", () => {
    const outcomes = evaluateBudgets({
      downloadViaApi: result({ name: "downloadViaApi", bytesPerSecond: 90 }),
      downloadDirect: result({ name: "downloadDirect", bytesPerSecond: 100 }),
    });
    const ratio = outcomes.find((o) => o.scenario === "downloadViaApi");
    expect(ratio?.status).toBe("pass");
  });

  it("fails the download ratio budget below 90%", () => {
    const outcomes = evaluateBudgets({
      downloadViaApi: result({ name: "downloadViaApi", bytesPerSecond: 50 }),
      downloadDirect: result({ name: "downloadDirect", bytesPerSecond: 100 }),
    });
    const ratio = outcomes.find((o) => o.scenario === "downloadViaApi");
    expect(ratio?.status).toBe("fail");
  });

  it("skips the download ratio budget when only one side ran", () => {
    const outcomes = evaluateBudgets({
      downloadViaApi: result({ name: "downloadViaApi", bytesPerSecond: 50 }),
    });
    const ratio = outcomes.find((o) => o.scenario === "downloadViaApi");
    expect(ratio?.status).toBe("skipped");
  });

  it("passes uploadSmallBurst under 30 seconds and fails at or over", () => {
    const under = evaluateBudgets({
      uploadSmallBurst: result({ name: "uploadSmallBurst", wallTimeMs: 29_999 }),
    });
    const over = evaluateBudgets({
      uploadSmallBurst: result({ name: "uploadSmallBurst", wallTimeMs: 30_000 }),
    });
    expect(under.find((o) => o.scenario === "uploadSmallBurst")?.status).toBe("pass");
    expect(over.find((o) => o.scenario === "uploadSmallBurst")?.status).toBe("fail");
  });
});

describe("allBudgetsPassed", () => {
  it("is true when every outcome is pass, informational, or skipped", () => {
    const outcomes = evaluateBudgets({});
    expect(allBudgetsPassed(outcomes)).toBe(true);
  });

  it("is false when any outcome failed", () => {
    const outcomes = evaluateBudgets({ list1k: result({ name: "list1k", p95Ms: 500 }) });
    expect(allBudgetsPassed(outcomes)).toBe(false);
  });
});
