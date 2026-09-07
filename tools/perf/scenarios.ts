import { ListResponse, SearchResponse } from "@fdrive/contracts";
import { fillPseudoRandomBytes } from "./byte-generator.js";
import { mapWithConcurrency } from "./concurrency.js";
import { alternatingPairs, drain } from "./measure.js";
import { type ScenarioResult, toScenarioResult } from "./results.js";
import { TOPICS } from "./search-fixture.js";
import { BIG_FILE_BYTES, type PerfStack } from "./stack.js";
export interface DurationOptions {
  readonly quickSeconds?: number;
}
export function durationSeconds(
  normalSeconds: number,
  options: DurationOptions,
  floorSeconds = 0,
): number {
  return Math.max(options.quickSeconds ?? normalSeconds, floorSeconds);
}
async function listing(stack: PerfStack, path: string, count: number): Promise<void> {
  const response = await fetch(
    `${stack.apiBaseUrl}/api/v1/fs/list?${new URLSearchParams({ path })}`,
    { headers: { cookie: stack.cookie }, signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw Error(`Listing failed: ${response.status}`);
  const body = ListResponse.parse(await response.json());
  if (body.entries.length !== count)
    throw Error(`Expected ${count} listing entries, received ${body.entries.length}`);
}
export async function runList1kCold(stack: PerfStack): Promise<ScenarioResult> {
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await listing(stack, `/cold-${i}`, 1000);
    samples.push(performance.now() - start);
  }
  return toScenarioResult("list1kCold", samples, 20000 / samples.reduce((a, b) => a + b, 0), 0, {
    uniquePaths: 20,
  });
}
async function warmListing(
  stack: PerfStack,
  path: string,
  count: number,
  name: string,
  options: DurationOptions,
): Promise<ScenarioResult> {
  for (let i = 0; i < 20; i++) await listing(stack, path, count);
  const samples: number[] = [];
  for (let i = 0; i < (options.quickSeconds ? 10 : 100); i++) {
    const start = performance.now();
    await listing(stack, path, count);
    samples.push(performance.now() - start);
  }
  return toScenarioResult(
    name,
    samples,
    (samples.length * 1000) / samples.reduce((a, b) => a + b, 0),
    0,
    { warmupCount: 20 },
  );
}
export function runList1kWarm(
  stack: PerfStack,
  options: DurationOptions = {},
): Promise<ScenarioResult> {
  return warmListing(stack, "/flat-1k", 1000, "list1k", options);
}
export function runList10kWarm(
  stack: PerfStack,
  options: DurationOptions = {},
): Promise<ScenarioResult> {
  return warmListing(stack, "/flat-10k", 10000, "list10k", options);
}
export async function runDownloads(
  stack: PerfStack,
  options: DurationOptions = {},
): Promise<{ downloadDirect: ScenarioResult; downloadViaApi: ScenarioResult }> {
  const measurements = {
    direct: { samples: [] as number[], bytes: [] as number[] },
    api: { samples: [] as number[], bytes: [] as number[] },
  };
  async function transfer(kind: "direct" | "api", record: boolean) {
    const direct = kind === "direct";
    const url = direct
      ? `${stack.sftpgoBaseUrl}/api/v2/user/files?path=/big/large.bin`
      : `${stack.apiBaseUrl}/api/v1/fs/download?path=/big/large.bin`;
    const start = performance.now();
    const bytes = await drain(
      await fetch(url, {
        headers: direct
          ? { authorization: `Bearer ${stack.sftpgoToken}` }
          : { cookie: stack.cookie },
        signal: AbortSignal.timeout(180000),
      }),
      BIG_FILE_BYTES,
    );
    if (record) {
      measurements[kind].samples.push(performance.now() - start);
      measurements[kind].bytes.push(bytes);
    }
  }
  await transfer("direct", false);
  await transfer("api", false);
  for (const pair of alternatingPairs(options.quickSeconds ? 1 : 3))
    for (const kind of pair) await transfer(kind, true);
  function result(kind: "direct" | "api") {
    const m = measurements[kind];
    const seconds = m.samples.reduce((a, b) => a + b, 0) / 1000;
    return toScenarioResult(
      kind === "direct" ? "downloadDirect" : "downloadViaApi",
      m.samples,
      m.samples.length / seconds,
      0,
      {
        bytesPerSecond: m.bytes.reduce((a, b) => a + b, 0) / seconds,
        completedBytes: m.bytes,
        expectedBytes: BIG_FILE_BYTES,
        warmupCount: 1,
      },
    );
  }
  return { downloadDirect: result("direct"), downloadViaApi: result("api") };
}
export async function runUploadSmallBurst(stack: PerfStack): Promise<ScenarioResult> {
  const indices = Array.from({ length: 200 }, (_, i) => i);
  const samples: number[] = [];
  const start = performance.now();
  await mapWithConcurrency(indices, 6, async (i) => {
    const bytes = fillPseudoRandomBytes(4096, i + 1).bytes;
    const one = performance.now();
    await drain(
      await fetch(
        `${stack.apiBaseUrl}/api/v1/fs/upload?path=/burst/${String(i).padStart(3, "0")}.bin`,
        {
          method: "PUT",
          headers: {
            cookie: stack.cookie,
            "x-requested-with": "fdrive",
            "content-type": "application/octet-stream",
          },
          body: bytes,
          signal: AbortSignal.timeout(30000),
        },
      ),
    );
    samples.push(performance.now() - one);
  });
  const wallTimeMs = performance.now() - start;
  await listing(stack, "/burst", 200);
  await mapWithConcurrency(indices, 6, async (i) => {
    const response = await fetch(
      `${stack.apiBaseUrl}/api/v1/fs/download?path=/burst/${String(i).padStart(3, "0")}.bin`,
      { headers: { cookie: stack.cookie } },
    );
    if (!response.ok) throw Error("Upload verification download failed");
    const actual = new Uint8Array(await response.arrayBuffer());
    const expected = fillPseudoRandomBytes(4096, i + 1).bytes;
    if (actual.length !== expected.length || actual.some((v, n) => v !== expected[n]))
      throw Error("Uploaded bytes differ");
  });
  return toScenarioResult("uploadSmallBurst", samples, 200000 / wallTimeMs, 0, {
    wallTimeMs,
    verifiedCount: 200,
  });
}
export async function runSearch(
  stack: PerfStack,
  options: DurationOptions = {},
): Promise<ScenarioResult> {
  async function query(index: number, cookie: string, forbidden = false) {
    const topic = TOPICS[index % TOPICS.length];
    if (!topic) throw Error("Missing query");
    const response = await fetch(
      `${stack.apiBaseUrl}/api/v1/search?${new URLSearchParams({ q: index % 3 === 0 ? (topic.split(" ")[0] ?? topic) : index % 3 === 1 ? topic : `practical observations about ${topic}`, limit: "30" })}`,
      { headers: { cookie }, signal: AbortSignal.timeout(30000) },
    );
    if (!response.ok) throw Error(`Search failed: ${response.status}`);
    const body = SearchResponse.parse(await response.json());
    const hits = [...body.sections.files, ...body.sections.content];
    if (body.degraded || body.unavailable || hits.length === 0)
      throw Error("Hybrid search degraded, unavailable or empty");
    if (hits.some((h) => h.name.startsWith("FORBIDDEN") !== forbidden))
      throw Error("Search crossed identity boundary");
    if (!forbidden && !hits.some((h) => h.name.startsWith(topic.split(" ")[0] ?? "")))
      throw Error("Expected topical hit absent");
  }
  await query(0, stack.forbiddenCookie, true);
  for (let i = 0; i < 20; i++) await query(i, stack.cookie);
  const samples: number[] = [];
  for (let i = 0; i < (options.quickSeconds ? 10 : 100); i++) {
    const start = performance.now();
    await query(i, stack.cookie);
    samples.push(performance.now() - start);
  }
  return toScenarioResult(
    "search25k",
    samples,
    (samples.length * 1000) / samples.reduce((a, b) => a + b, 0),
    0,
    { warmupCount: 20, verifiedCount: 25000 },
  );
}
