import type { ScenarioResult } from "./results.js";

export type ScenarioName =
  | "list1kCold"
  | "list1k"
  | "list10k"
  | "uiList"
  | "uiGrid"
  | "search25k"
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
export const REQUIRED_SCENARIOS: readonly ScenarioName[] = [
  "list1kCold",
  "list1k",
  "uiList",
  "uiGrid",
  "search25k",
  "downloadViaApi",
  "downloadDirect",
  "uploadSmallBurst",
];
const MIN_SAMPLES: Record<string, number> = {
  list1kCold: 20,
  list1k: 100,
  uiList: 5,
  uiGrid: 5,
  search25k: 100,
  downloadViaApi: 3,
  downloadDirect: 3,
  uploadSmallBurst: 200,
};

function enough(value: number | undefined, minimum: number): boolean {
  return Number.isInteger(value) && Number(value) >= minimum;
}

/** Missing, failed, incomplete or nonfinite observations can never satisfy a gate. */
export function validMeasurement(name: ScenarioName, result: ScenarioResult | undefined): boolean {
  if (result?.errors !== 0 || result.samplesMs.length < (MIN_SAMPLES[name] ?? 1)) return false;
  if (
    ![
      result.p50Ms,
      result.p95Ms,
      result.p99Ms,
      result.requestsPerSecond,
      ...result.samplesMs,
    ].every((v) => Number.isFinite(v) && v > 0)
  )
    return false;
  if ((name === "list1k" || name === "search25k") && !enough(result.warmupCount, 20)) return false;
  if (name === "list1kCold" && !enough(result.uniquePaths, 20)) return false;
  if (name === "uploadSmallBurst" && result.verifiedCount !== 200) return false;
  if (name === "uiList" || name === "uiGrid")
    return (
      result.verifiedCount === 10000 &&
      enough(result.maxMounted, 1) &&
      Number(result.maxMounted) < 500
    );
  if (name === "downloadViaApi" || name === "downloadDirect")
    return (
      result.expectedBytes === 512 * 1024 * 1024 &&
      result.completedBytes?.length === result.samplesMs.length &&
      result.completedBytes.every((n) => n === result.expectedBytes) &&
      Number.isFinite(result.bytesPerSecond) &&
      Number(result.bytesPerSecond) > 0 &&
      enough(result.warmupCount, 1)
    );
  return true;
}

export function evaluateBudgets(results: ScenarioResults): BudgetOutcome[] {
  return REQUIRED_SCENARIOS.map((name) => {
    const result = results[name];
    if (!validMeasurement(name, result) || result === undefined)
      return {
        scenario: name,
        budget: "complete valid observations",
        status: "fail",
        detail: "missing, failed, incomplete or nonfinite measurements",
      };
    if (name === "downloadViaApi") {
      const direct = results.downloadDirect;
      const ratio = Number(result.bytesPerSecond) / Number(direct?.bytesPerSecond);
      return {
        scenario: name,
        budget: "throughput >=90% direct",
        status: validMeasurement("downloadDirect", direct) && ratio >= 0.9 ? "pass" : "fail",
        detail: `${(ratio * 100).toFixed(2)}% of direct`,
      };
    }
    if (name === "downloadDirect")
      return {
        scenario: name,
        budget: "completed baseline transfers",
        status: "pass",
        detail: `${result.bytesPerSecond} bytes/s`,
      };
    const limit =
      name === "list1k"
        ? 100
        : name === "list1kCold"
          ? 400
          : name === "search25k"
            ? 300
            : name === "uploadSmallBurst"
              ? 30000
              : 500;
    const value = name === "uploadSmallBurst" ? Number(result.wallTimeMs) : result.p95Ms;
    return {
      scenario: name,
      budget: `${name === "uploadSmallBurst" ? "wall" : "p95"} <${limit} ms`,
      status: Number.isFinite(value) && value > 0 && value < limit ? "pass" : "fail",
      detail: `${value} ms`,
    };
  });
}
export function allBudgetsPassed(outcomes: readonly BudgetOutcome[]): boolean {
  return (
    outcomes.length === REQUIRED_SCENARIOS.length &&
    REQUIRED_SCENARIOS.every(
      (name) => outcomes.filter((o) => o.scenario === name && o.status === "pass").length === 1,
    )
  );
}
