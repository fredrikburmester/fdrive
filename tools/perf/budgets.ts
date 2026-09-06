import type { ScenarioResult } from "./results.js";

/** The scenario names the budget table checks, matching PLAN.md §6's budgets table. */
export type ScenarioName =
  | "list1kCold"
  | "list1k"
  | "list10k"
  | "downloadViaApi"
  | "downloadDirect"
  | "uploadSmallBurst";

export type BudgetStatus = "pass" | "fail" | "informational" | "skipped";

export interface BudgetOutcome {
  readonly scenario: string;
  readonly budget: string;
  readonly status: BudgetStatus;
  readonly detail: string;
}

export type ScenarioResults = Partial<Record<ScenarioName, ScenarioResult>>;

function evaluateLessThan(
  scenario: string,
  budget: string,
  value: number | undefined,
  limit: number,
  unit: string,
): BudgetOutcome {
  if (value === undefined || Number.isNaN(value)) {
    return { scenario, budget, status: "skipped", detail: "scenario not run" };
  }
  const pass = value < limit;
  return {
    scenario,
    budget,
    status: pass ? "pass" : "fail",
    detail: `${value.toFixed(1)} ${unit} (budget < ${limit} ${unit})`,
  };
}

function evaluateInformational(
  scenario: string,
  budget: string,
  value: number | undefined,
  unit: string,
): BudgetOutcome {
  if (value === undefined || Number.isNaN(value)) {
    return { scenario, budget, status: "skipped", detail: "scenario not run" };
  }
  return { scenario, budget, status: "informational", detail: `${value.toFixed(1)} ${unit}` };
}

function evaluateThroughputRatio(
  viaApi: ScenarioResult | undefined,
  direct: ScenarioResult | undefined,
): BudgetOutcome {
  const scenario = "downloadViaApi";
  const budget = "throughput >= 90% of downloadDirect";
  if (viaApi === undefined || direct === undefined) {
    return { scenario, budget, status: "skipped", detail: "scenario not run" };
  }
  const viaBytes = viaApi.bytesPerSecond;
  const directBytes = direct.bytesPerSecond;
  if (viaBytes === undefined || directBytes === undefined || directBytes <= 0) {
    return { scenario, budget, status: "skipped", detail: "throughput not measured" };
  }
  const ratio = viaBytes / directBytes;
  const pass = ratio >= 0.9;
  return {
    scenario,
    budget,
    status: pass ? "pass" : "fail",
    detail: `${(ratio * 100).toFixed(1)}% of direct`,
  };
}

/**
 * Evaluates every budget from PLAN.md §6 against whichever scenario results
 * are present. A scenario that was not run (e.g. because `--only` selected
 * a different one) yields a "skipped" outcome rather than a failure. Pure:
 * takes the results map as an argument, no I/O.
 */
export function evaluateBudgets(results: ScenarioResults): BudgetOutcome[] {
  return [
    evaluateLessThan("list1k", "warm p95 < 100 ms", results.list1k?.p95Ms, 100, "ms"),
    evaluateLessThan("list1kCold", "cold < 400 ms", results.list1kCold?.p95Ms, 400, "ms"),
    evaluateInformational("list10k", "warm p95, informational only", results.list10k?.p95Ms, "ms"),
    evaluateThroughputRatio(results.downloadViaApi, results.downloadDirect),
    evaluateLessThan(
      "uploadSmallBurst",
      "wall time < 30 s",
      results.uploadSmallBurst?.wallTimeMs,
      30_000,
      "ms",
    ),
  ];
}

/** True when no outcome has status "fail" (informational and skipped never fail a run). */
export function allBudgetsPassed(outcomes: readonly BudgetOutcome[]): boolean {
  return outcomes.every((outcome) => outcome.status !== "fail");
}
