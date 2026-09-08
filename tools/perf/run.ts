/** Full runs gate by default. Diagnostic flags never claim full-gate success. */
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs, SCENARIO_NAMES } from "./args.js";
import { runBrowser } from "./browser.js";
import { allBudgetsPassed, evaluateBudgets, type ScenarioResults } from "./budgets.js";
import { formatBudgetsTable, formatResultsTable, resultsFileName } from "./format.js";
import { finishCleanup } from "./lifecycle.js";
import { toScenarioResult } from "./results.js";
import {
  runDownloads,
  runList1kCold,
  runList1kWarm,
  runList10kWarm,
  runSearch,
  runUploadSmallBurst,
} from "./scenarios.js";
import { startPerfStack } from "./stack.js";
export function resultsDir(): string {
  return join(import.meta.dirname, "results");
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const results: ScenarioResults = {};
  const failures: Record<string, string> = {};
  let browserVersion: string | undefined;
  let layoutChecks: unknown;
  const stack = await startPerfStack();
  try {
    const duration = options.quick ? { quickSeconds: 5 } : {};
    for (const name of options.only
      ? [options.only]
      : SCENARIO_NAMES.filter((name) => name !== "list10k")) {
      if (results[name]) continue;
      console.log(`[perf] measuring ${name}`);
      try {
        switch (name) {
          case "list1kCold":
            results[name] = await runList1kCold(stack);
            break;
          case "list1k":
            results[name] = await runList1kWarm(stack, duration);
            break;
          case "list10k":
            results[name] = await runList10kWarm(stack, duration);
            break;
          case "search25k":
            results[name] = await runSearch(stack, duration);
            break;
          case "uploadSmallBurst":
            results[name] = await runUploadSmallBurst(stack);
            break;
          case "downloadDirect":
          case "downloadViaApi":
            Object.assign(results, await runDownloads(stack, duration));
            break;
          case "uiList":
          case "uiGrid": {
            const browser = await runBrowser(stack);
            results.uiList = browser.uiList;
            results.uiGrid = browser.uiGrid;
            browserVersion = browser.browserVersion;
            layoutChecks = browser.layoutChecks;
            break;
          }
        }
      } catch (error) {
        failures[name] = error instanceof Error ? error.message : "Scenario failed";
        results[name] = toScenarioResult(name, [], 0, 1);
        console.error(`[perf] ${name} failed: ${failures[name]}`);
      }
    }
  } finally {
    await finishCleanup(() => stack.stop(), failures);
    if (failures.cleanup) console.error(`[perf] cleanup failed: ${failures.cleanup}`);
  }
  const budgets = evaluateBudgets(results);
  const passed = options.strict && Object.keys(failures).length === 0 && allBudgetsPassed(budgets);
  console.log(formatResultsTable(Object.values(results)));
  console.log(formatBudgetsTable(budgets));
  await mkdir(resultsDir(), { recursive: true });
  const path = join(resultsDir(), resultsFileName(new Date()));
  await writeFile(
    path,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: options.strict ? "strict" : "diagnostic",
        fullGatePassed: passed,
        environment: {
          node: process.version,
          platform: platform(),
          arch: arch(),
          release: release(),
          cpus: cpus().length,
          cpu: cpus()[0]?.model,
          totalMemory: totalmem(),
          browserVersion,
          layoutChecks,
          model: stack.teiRuntime.model,
          teiImage: stack.teiRuntime.image,
          teiPlatform: stack.teiRuntime.platform,
          teiSource: stack.teiRuntime.source,
          embeddingDimensions: 384,
          searchFiles: 25000,
          contentTemplates: 32,
          repeatedTemplateEmbeddings: true,
          downloadBytes: 512 * 1024 * 1024,
          storage: "disposable Docker volume, shared SFTPGo RW and indexer RO",
        },
        results,
        budgets,
        failures,
      },
      null,
      2,
    ),
  );
  console.log(`[perf] wrote ${path}`);
  if (options.strict && !passed) process.exitCode = 1;
  else if (Object.keys(failures).length) process.exitCode = 1;
  console.log(
    passed
      ? "[perf] FULL GATE PASSED"
      : options.strict
        ? "[perf] FULL GATE FAILED"
        : "[perf] DIAGNOSTIC ONLY; not a full-gate result",
  );
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Performance harness failed");
    process.exitCode = 1;
  });
