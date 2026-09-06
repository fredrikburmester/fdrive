import { describe, expect, it } from "vitest";
import type { BudgetOutcome } from "./budgets.js";
import {
  formatBudgetsTable,
  formatBytesPerSecond,
  formatMarkdownTable,
  formatMs,
  formatResultsTable,
  resultsFileName,
} from "./format.js";
import type { ScenarioResult } from "./results.js";

describe("formatMarkdownTable", () => {
  it("renders a header row, a divider row, and one row per input row", () => {
    const table = formatMarkdownTable(["a", "b"], [["1", "2"]]);
    const lines = table.split("\n");
    expect(lines).toEqual(["| a | b |", "| --- | --- |", "| 1 | 2 |"]);
  });

  it("handles zero body rows", () => {
    const table = formatMarkdownTable(["a"], []);
    expect(table).toBe("| a |\n| --- |");
  });
});

describe("formatBytesPerSecond", () => {
  it("converts bytes per second to MiB/s with two decimals", () => {
    expect(formatBytesPerSecond(1024 * 1024)).toBe("1.00 MiB/s");
    expect(formatBytesPerSecond(1024 * 1024 * 2.5)).toBe("2.50 MiB/s");
  });

  it("handles zero", () => {
    expect(formatBytesPerSecond(0)).toBe("0.00 MiB/s");
  });
});

describe("formatMs", () => {
  it("formats a finite number with one decimal", () => {
    expect(formatMs(12.345)).toBe("12.3 ms");
  });

  it("formats NaN as a dash", () => {
    expect(formatMs(Number.NaN)).toBe("-");
  });
});

function result(overrides: Partial<ScenarioResult> & { name: string }): ScenarioResult {
  return {
    p50Ms: 1,
    p95Ms: 2,
    p99Ms: 3,
    requestsPerSecond: 4,
    errors: 0,
    ...overrides,
  };
}

describe("formatResultsTable", () => {
  it("includes every scenario name as a row", () => {
    const table = formatResultsTable([result({ name: "list1k" }), result({ name: "list10k" })]);
    expect(table).toContain("list1k");
    expect(table).toContain("list10k");
  });

  it("renders a dash for missing bytesPerSecond and wallTimeMs", () => {
    const table = formatResultsTable([result({ name: "list1k" })]);
    const dataRow = table.split("\n")[2] as string;
    expect(dataRow).toContain("-");
  });

  it("renders bytesPerSecond and wallTimeMs when present", () => {
    const table = formatResultsTable([
      result({ name: "downloadViaApi", bytesPerSecond: 1024 * 1024, wallTimeMs: 2000 }),
    ]);
    expect(table).toContain("1.00 MiB/s");
    expect(table).toContain("2.0 s");
  });

  it("renders a dash for NaN requestsPerSecond", () => {
    const table = formatResultsTable([result({ name: "list1k", requestsPerSecond: Number.NaN })]);
    const dataRow = table.split("\n")[2] as string;
    const cells = dataRow.split("|").map((cell) => cell.trim());
    expect(cells).toContain("-");
  });
});

describe("formatBudgetsTable", () => {
  it("renders scenario, budget, status, and detail columns", () => {
    const outcomes: BudgetOutcome[] = [
      { scenario: "list1k", budget: "warm p95 < 100 ms", status: "pass", detail: "42.0 ms" },
    ];
    const table = formatBudgetsTable(outcomes);
    expect(table).toContain("list1k");
    expect(table).toContain("warm p95 < 100 ms");
    expect(table).toContain("pass");
    expect(table).toContain("42.0 ms");
  });
});

describe("resultsFileName", () => {
  it("replaces colons and dots with hyphens and appends .json", () => {
    const date = new Date("2026-09-06T13:45:00.123Z");
    expect(resultsFileName(date)).toBe("2026-09-06T13-45-00-123Z.json");
  });

  it("is unique to the millisecond", () => {
    const a = resultsFileName(new Date("2026-09-06T13:45:00.001Z"));
    const b = resultsFileName(new Date("2026-09-06T13:45:00.002Z"));
    expect(a).not.toBe(b);
  });
});
