export interface BrowserMeasurements {
  browser: string;
  layoutChecks?: unknown;
  results: Record<
    string,
    { samplesMs: number[]; maxMounted: number; verifiedCount: 10000; diagnostics?: unknown }
  >;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw Error("Invalid browser measurement object");
  return value as Record<string, unknown>;
}
export function parseBrowserOutput(value: unknown): BrowserMeasurements {
  const object = record(value);
  if (typeof object.browser !== "string") throw Error("Missing browser version");
  const results: BrowserMeasurements["results"] = {};
  for (const [name, entry] of Object.entries(record(object.results))) {
    const r = record(entry);
    if (
      !Array.isArray(r.samplesMs) ||
      !r.samplesMs.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0) ||
      typeof r.maxMounted !== "number" ||
      !Number.isInteger(r.maxMounted) ||
      r.maxMounted < 1 ||
      r.verifiedCount !== 10000
    )
      throw Error("Invalid browser measurements");
    results[name] = {
      samplesMs: r.samplesMs as number[],
      maxMounted: r.maxMounted,
      verifiedCount: 10000,
      diagnostics: r.diagnostics,
    };
  }
  return { browser: object.browser, results, layoutChecks: object.layoutChecks };
}
