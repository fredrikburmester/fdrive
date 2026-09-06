/**
 * CLI entry point: `pnpm perf` (or `pnpm perf:quick`). Starts the real
 * stack, runs the requested scenario(s), prints the results and budget
 * tables, writes a timestamped JSON snapshot under `tools/perf/results/`,
 * and exits non-zero only when `--strict` was passed and a budget failed
 * (budgets are informational until PLAN.md's phase 5).
 *
 * Flags: `--only <scenario>` runs a single scenario; `--quick` shortens
 * every timed scenario to 5 seconds; `--strict` makes a failed budget exit
 * non-zero.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, SCENARIO_NAMES } from "./args.js";
import {
  allBudgetsPassed,
  evaluateBudgets,
  type ScenarioName,
  type ScenarioResults,
} from "./budgets.js";
import { formatBudgetsTable, formatResultsTable, resultsFileName } from "./format.js";
import type { ScenarioResult } from "./results.js";
import {
  runDownloadDirect,
  runDownloadViaApi,
  runList1kCold,
  runList1kWarm,
  runList10kWarm,
  runUploadSmallBurst,
} from "./scenarios.js";
import { type PerfStack, startPerfStack } from "./stack.js";

/** Seconds every timed scenario is shortened to when `--quick` is passed. */
const QUICK_SECONDS = 5;

type ScenarioRunner = (
  stack: PerfStack,
  quickSeconds: number | undefined,
) => Promise<ScenarioResult>;

const SCENARIO_RUNNERS: Record<ScenarioName, ScenarioRunner> = {
  list1kCold: (stack) => runList1kCold(stack),
  list1k: (stack, quickSeconds) =>
    runList1kWarm(stack, quickSeconds !== undefined ? { quickSeconds } : {}),
  list10k: (stack, quickSeconds) =>
    runList10kWarm(stack, quickSeconds !== undefined ? { quickSeconds } : {}),
  downloadViaApi: (stack, quickSeconds) =>
    runDownloadViaApi(stack, quickSeconds !== undefined ? { quickSeconds } : {}),
  downloadDirect: (stack, quickSeconds) =>
    runDownloadDirect(stack, quickSeconds !== undefined ? { quickSeconds } : {}),
  uploadSmallBurst: (stack) => runUploadSmallBurst(stack),
};

/** Absolute path to `tools/perf/results`, where timestamped JSON snapshots land. */
export function resultsDir(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return join(scriptDir, "results");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const order: ScenarioName[] = options.only !== undefined ? [options.only] : [...SCENARIO_NAMES];
  const quickSeconds = options.quick ? QUICK_SECONDS : undefined;

  console.log(`[perf] scenarios: ${order.join(", ")}${options.quick ? " (quick)" : ""}`);

  const stack = await startPerfStack();
  const results: ScenarioResults = {};

  try {
    for (const name of order) {
      console.log(`[perf] running scenario: ${name}`);
      const runner = SCENARIO_RUNNERS[name];
      results[name] = await runner(stack, quickSeconds);
    }
  } finally {
    await stack.stop();
  }

  const allResults = Object.values(results) as ScenarioResult[];
  console.log("\n## Results\n");
  console.log(formatResultsTable(allResults));

  const outcomes = evaluateBudgets(results);
  console.log("\n## Budgets\n");
  console.log(formatBudgetsTable(outcomes));

  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, resultsFileName(new Date()));
  writeFileSync(
    filePath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), results, budgets: outcomes }, null, 2)}\n`,
    "utf-8",
  );
  console.log(`\n[perf] wrote ${filePath}`);

  if (options.strict && !allBudgetsPassed(outcomes)) {
    console.error("\n[perf] one or more budgets failed and --strict was passed");
    process.exit(1);
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
