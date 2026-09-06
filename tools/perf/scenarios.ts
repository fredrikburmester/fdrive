/**
 * The perf scenarios from PLAN.md §6: each one drives the real, running
 * stack (`PerfStack` from `stack.ts`) with either `autocannon` (a short
 * load test) or plain `fetch` (a single cold request, or a small burst),
 * and returns a `ScenarioResult`. The scenario functions themselves are
 * I/O and are exercised by `pnpm perf`; the pure pieces they are built
 * from (`toScenarioResult`, `computeLatencyStats`, `mapWithConcurrency`,
 * `fillPseudoRandomBytes`) each have their own unit tests.
 */

import { ROUTES } from "@fdrive/contracts";
import autocannon from "autocannon";
import { fillPseudoRandomBytes } from "./byte-generator.js";
import { mapWithConcurrency } from "./concurrency.js";
import { type ScenarioResult, toScenarioResult } from "./results.js";
import type { PerfStack } from "./stack.js";

/** Header the API's CSRF guard requires on every state-changing request. */
const REQUESTED_WITH_HEADER = { "x-requested-with": "fdrive" } as const;

const WARM_UP_REQUESTS = 20;
const UPLOAD_BURST_COUNT = 200;
const UPLOAD_BURST_CONCURRENCY = 6;
const UPLOAD_BURST_FILE_BYTES = 4 * 1024;
/** Generous per-request timeout for the 512 MiB download scenarios; see `LoadScenarioOptions.timeoutSeconds`. */
const DOWNLOAD_TIMEOUT_SECONDS = 180;
/**
 * A floor under `--quick`'s 5 s for the download scenarios: autocannon
 * hard-destroys every in-flight connection once its duration elapses (see
 * `run.ts` in the `autocannon` package), so a duration shorter than one full
 * 512 MiB transfer measures nothing at all (0 req/s, 0 bytes/s) rather than
 * a real, if limited, data point. 20 s comfortably covers one transfer on a
 * typical dev machine while still being well under the full 30 s duration.
 */
const MIN_DOWNLOAD_QUICK_SECONDS = 20;

export interface DurationOptions {
  /** Shortens every timed scenario to this many seconds instead of its normal duration. */
  readonly quickSeconds?: number;
}

/**
 * Resolves the duration (in seconds) a load scenario should run for:
 * `options.quickSeconds` when set, clamped up to `floorSeconds` (defaults
 * to 0, i.e. no floor), otherwise `normalSeconds`. Pure.
 */
export function durationSeconds(
  normalSeconds: number,
  options: DurationOptions,
  floorSeconds = 0,
): number {
  const requested = options.quickSeconds ?? normalSeconds;
  return Math.max(requested, floorSeconds);
}

/** Sends `count` GETs to `url` sequentially and discards the bodies, to warm the API's list cache. */
async function warmUp(url: string, headers: Record<string, string>, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const response = await fetch(url, { headers });
    await response.arrayBuffer();
  }
}

interface LoadScenarioOptions {
  readonly name: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly connections: number;
  readonly durationSeconds: number;
  /**
   * Per-request response timeout, in seconds (autocannon's own `timeout`
   * option, default 10). A 512 MiB file can legitimately take longer than
   * 10 s to finish downloading over Docker Desktop's networking, so the
   * download scenarios pass a much larger value here; without it,
   * autocannon aborts every in-flight request once `timeout` elapses,
   * which reads as 0 requests/sec and 0 bytes/sec rather than a real
   * (slow) measurement.
   */
  readonly timeoutSeconds?: number;
}

/**
 * Runs a `GET` autocannon load test against `options.url`, tracking every
 * individual response's latency itself (via `setupClient`) so the result's
 * p50/p95/p99 are exact percentiles rather than autocannon's own nearest
 * bucket (which does not include p95). Requests-per-second and
 * bytes-per-second come from autocannon's own aggregate stats. Every perf
 * scenario that goes through this helper is a `GET` (list, download); the
 * upload burst scenario uses plain `fetch` instead, since it needs a
 * distinct body per request.
 */
async function runLoadScenario(options: LoadScenarioOptions): Promise<ScenarioResult> {
  const latenciesMs: number[] = [];

  const result = await autocannon({
    url: options.url,
    method: "GET",
    headers: options.headers ?? {},
    connections: options.connections,
    duration: options.durationSeconds,
    ...(options.timeoutSeconds !== undefined ? { timeout: options.timeoutSeconds } : {}),
    setupClient(client) {
      client.on("response", (_statusCode, _resBytes, responseTime) => {
        latenciesMs.push(responseTime);
      });
    },
  });

  const errors = result.errors + result.non2xx + result.timeouts;
  return toScenarioResult(options.name, latenciesMs, result.requests.average, errors, {
    bytesPerSecond: result.throughput.average,
  });
}

/** A single, uncached `GET /fs/list?path=/flat-1k`, measured once with `performance.now()`. */
export async function runList1kCold(stack: PerfStack): Promise<ScenarioResult> {
  const url = `${stack.apiBaseUrl}${ROUTES.fs.list}?path=/flat-1k`;
  const start = performance.now();
  const response = await fetch(url, { headers: { cookie: stack.cookie } });
  await response.arrayBuffer();
  const elapsedMs = performance.now() - start;
  const errors = response.ok ? 0 : 1;
  const requestsPerSecond = elapsedMs > 0 ? 1000 / elapsedMs : Number.NaN;
  return toScenarioResult("list1kCold", [elapsedMs], requestsPerSecond, errors);
}

/** `GET /fs/list?path=/flat-1k`, warm: 20 warm-up requests, then a 15 s (5 s quick) load test at 10 connections. */
export async function runList1kWarm(
  stack: PerfStack,
  options: DurationOptions = {},
): Promise<ScenarioResult> {
  const url = `${stack.apiBaseUrl}${ROUTES.fs.list}?path=/flat-1k`;
  const headers = { cookie: stack.cookie };
  await warmUp(url, headers, WARM_UP_REQUESTS);
  return runLoadScenario({
    name: "list1k",
    url,
    headers,
    connections: 10,
    durationSeconds: durationSeconds(15, options),
  });
}

/** `GET /fs/list?path=/flat-10k`, warm: same shape as `runList1kWarm`. */
export async function runList10kWarm(
  stack: PerfStack,
  options: DurationOptions = {},
): Promise<ScenarioResult> {
  const url = `${stack.apiBaseUrl}${ROUTES.fs.list}?path=/flat-10k`;
  const headers = { cookie: stack.cookie };
  await warmUp(url, headers, WARM_UP_REQUESTS);
  return runLoadScenario({
    name: "list10k",
    url,
    headers,
    connections: 10,
    durationSeconds: durationSeconds(15, options),
  });
}

/**
 * `GET /fs/download?path=/big/large.bin` through the fdrive API, 2
 * connections, 30 s (20 s floor under `--quick`; see
 * `MIN_DOWNLOAD_QUICK_SECONDS`).
 */
export async function runDownloadViaApi(
  stack: PerfStack,
  options: DurationOptions = {},
): Promise<ScenarioResult> {
  const url = `${stack.apiBaseUrl}${ROUTES.fs.download}?path=/big/large.bin`;
  return runLoadScenario({
    name: "downloadViaApi",
    url,
    headers: { cookie: stack.cookie },
    connections: 2,
    durationSeconds: durationSeconds(30, options, MIN_DOWNLOAD_QUICK_SECONDS),
    timeoutSeconds: DOWNLOAD_TIMEOUT_SECONDS,
  });
}

/** The same file straight from SFTPGo's user API, for the ≥ 90% throughput ratio budget. */
export async function runDownloadDirect(
  stack: PerfStack,
  options: DurationOptions = {},
): Promise<ScenarioResult> {
  const url = `${stack.sftpgoBaseUrl}/api/v2/user/files?path=/big/large.bin`;
  return runLoadScenario({
    name: "downloadDirect",
    url,
    headers: { authorization: `Bearer ${stack.sftpgoToken}` },
    connections: 2,
    durationSeconds: durationSeconds(30, options, MIN_DOWNLOAD_QUICK_SECONDS),
    timeoutSeconds: DOWNLOAD_TIMEOUT_SECONDS,
  });
}

/** 200 x 4 KiB `PUT /fs/upload` calls, 6 concurrent workers, plain `fetch`, measuring wall time. */
export async function runUploadSmallBurst(stack: PerfStack): Promise<ScenarioResult> {
  const digits = String(UPLOAD_BURST_COUNT - 1).length;
  const indices = Array.from({ length: UPLOAD_BURST_COUNT }, (_, i) => i);
  const latenciesMs: number[] = [];
  let errors = 0;

  const start = performance.now();
  await mapWithConcurrency(indices, UPLOAD_BURST_CONCURRENCY, async (index) => {
    const name = String(index).padStart(digits, "0");
    const { bytes } = fillPseudoRandomBytes(UPLOAD_BURST_FILE_BYTES, index + 1);
    const url = `${stack.apiBaseUrl}${ROUTES.fs.upload}?path=/burst/${name}.bin&mkdirParents=true`;
    const requestStart = performance.now();
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        cookie: stack.cookie,
        "content-type": "application/octet-stream",
        ...REQUESTED_WITH_HEADER,
      },
      body: bytes,
    });
    const responseBody = await response.text();
    latenciesMs.push(performance.now() - requestStart);
    if (!response.ok) {
      errors += 1;
      console.error(`[perf] uploadSmallBurst: ${url} -> ${response.status} ${responseBody}`);
    }
  });
  const wallTimeMs = performance.now() - start;

  const requestsPerSecond = wallTimeMs > 0 ? (UPLOAD_BURST_COUNT * 1000) / wallTimeMs : Number.NaN;
  return toScenarioResult("uploadSmallBurst", latenciesMs, requestsPerSecond, errors, {
    wallTimeMs,
  });
}
