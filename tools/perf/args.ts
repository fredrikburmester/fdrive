import type { ScenarioName } from "./budgets.js";

export const SCENARIO_NAMES: readonly ScenarioName[] = [
  "list1kCold",
  "list1k",
  "list10k",
  "uiList",
  "uiGrid",
  "search25k",
  "downloadViaApi",
  "downloadDirect",
  "uploadSmallBurst",
];

export interface CliOptions {
  readonly only: ScenarioName | undefined;
  readonly quick: boolean;
  readonly strict: boolean;
}

function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(value);
}

/**
 * Parses `tools/perf/run.ts`'s CLI flags: `--only <scenario>`, `--quick`,
 * `--strict`. Throws a plain `Error` with a human-readable message on
 * anything it does not recognize, so `run.ts` can print it and exit
 * non-zero. Pure: takes `argv` as an argument rather than reading
 * `process.argv` itself.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  let only: ScenarioName | undefined;
  let quick = false;
  let strict = false;
  let diagnostic = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--only requires a scenario name");
      }
      if (!isScenarioName(value)) {
        throw new Error(
          `--only "${value}" is not a known scenario; expected one of ${SCENARIO_NAMES.join(", ")}`,
        );
      }
      only = value;
      i += 1;
    } else if (arg === "--quick") {
      quick = true;
    } else if (arg === "--diagnostic") {
      diagnostic = true;
    } else if (arg === "--strict") {
      strict = true;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }

  if (strict && (quick || only !== undefined || diagnostic))
    throw new Error("--strict requires all full scenarios; no diagnostic flags");
  return { only, quick, strict: strict || (!quick && only === undefined && !diagnostic) };
}
