import type { BudgetOutcome } from "./budgets.js";
import type { ScenarioResult } from "./results.js";

/**
 * Renders a GitHub-flavoured markdown table from a header row and body
 * rows. Pure string formatting, no knowledge of what the columns mean.
 */
export function formatMarkdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const headerLine = `| ${headers.join(" | ")} |`;
  const dividerLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const rowLines = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerLine, dividerLine, ...rowLines].join("\n");
}

/** Formats a bytes-per-second throughput figure as a human-readable MiB/s string. */
export function formatBytesPerSecond(bytesPerSecond: number): string {
  const mib = bytesPerSecond / (1024 * 1024);
  return `${mib.toFixed(2)} MiB/s`;
}

/** Formats a millisecond duration, rounding to one decimal place. */
export function formatMs(ms: number): string {
  if (Number.isNaN(ms)) {
    return "-";
  }
  return `${ms.toFixed(1)} ms`;
}

/**
 * Renders the scenario results table printed to the console and embedded
 * in `docs/PERF.md`.
 */
export function formatResultsTable(results: readonly ScenarioResult[]): string {
  const headers = ["scenario", "p50", "p95", "p99", "req/s", "bytes/s", "wall time", "errors"];
  const rows = results.map((r) => [
    r.name,
    formatMs(r.p50Ms),
    formatMs(r.p95Ms),
    formatMs(r.p99Ms),
    Number.isNaN(r.requestsPerSecond) ? "-" : r.requestsPerSecond.toFixed(1),
    r.bytesPerSecond !== undefined ? formatBytesPerSecond(r.bytesPerSecond) : "-",
    r.wallTimeMs !== undefined ? `${(r.wallTimeMs / 1000).toFixed(1)} s` : "-",
    String(r.errors),
  ]);
  return formatMarkdownTable(headers, rows);
}

/** Renders the budget comparison table. */
export function formatBudgetsTable(outcomes: readonly BudgetOutcome[]): string {
  const headers = ["scenario", "budget", "status", "detail"];
  const rows = outcomes.map((o) => [o.scenario, o.budget, o.status, o.detail]);
  return formatMarkdownTable(headers, rows);
}

/**
 * Builds a filesystem-safe results file name from a timestamp, e.g.
 * `2026-09-06T13-45-00-000Z.json`. Pure and collision-resistant to the
 * millisecond.
 */
export function resultsFileName(date: Date): string {
  return `${date.toISOString().replace(/[:.]/g, "-")}.json`;
}
