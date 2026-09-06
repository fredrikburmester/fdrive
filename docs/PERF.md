# Performance harness

`tools/perf/` is a reproducible harness that measures the phase 1 performance budgets from
[PLAN.md §6](../PLAN.md#6-files-api-and-performance) against the real stack: a Postgres and an
SFTPGo testcontainer (the same containers the integration tests use), seeded over SFTPGo's own
REST API, plus the fdrive API running in-process on an ephemeral port.

Per PLAN.md §10 and §13, these budgets are **informational until phase 5**. `pnpm perf` never
fails the build on a missed budget unless you pass `--strict`.

## Running it

```sh
pnpm perf          # full run: 15 s list scenarios, 30 s download scenarios
pnpm perf:quick    # shortened run: 5 s list scenarios, 20 s floor on download scenarios
pnpm perf --only list1k       # a single scenario
pnpm perf:quick --strict      # exit non-zero if a budget fails
```

Each run starts fresh containers, seeds `/flat-1k` (1,000 files), `/flat-10k` (10,000 files), and
`/big/large.bin` (512 MiB) from scratch, runs the requested scenario(s), prints a results table and
a budgets table, and writes a timestamped JSON snapshot to `tools/perf/results/` (gitignored).
Seeding the fixtures over SFTPGo's REST API is the slowest part of a run, typically a minute or
two; streaming the 512 MiB file adds another chunk of that.

`--quick` does **not** blindly shrink every scenario to 5 seconds: the download scenarios have a
20 second floor, because autocannon hard-destroys every in-flight connection once its configured
duration elapses (see `tools/perf/scenarios.ts`'s `MIN_DOWNLOAD_QUICK_SECONDS`), and a single
512 MiB transfer routinely takes 10-15 seconds on a dev machine. Without the floor, a 5 second
download scenario measures nothing at all (0 req/s, 0 bytes/s) rather than a real, if limited, data
point.

## Baseline, 2026-09-06, Docker Desktop on the dev Mac

Command:

```sh
pnpm perf:quick
```

Environment:

- macOS 26.6.2, Apple Silicon (aarch64), Docker Desktop with a linuxkit VM (Docker Engine 29.4.0).
- Node v22.21.1, pnpm 10.11.0.
- Containers: `pgvector/pgvector:pg17` (Postgres), `drakkan/sftpgo:v2.7.5` (SFTPGo), both started
  fresh via `@fdrive/testkit`'s `startPostgres`/`startSftpgo`.
- Load generator: `autocannon` 8.0.0, in-process (same Node process as the harness), talking to the
  fdrive API over `127.0.0.1` on a loopback TCP port and to SFTPGo over its Docker-mapped port.

Results:

| scenario | p50 | p95 | p99 | req/s | bytes/s | wall time | errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| list1kCold | 15.4 ms | 15.4 ms | 15.4 ms | 64.8 | - | - | 0 |
| list1k | 33.1 ms | 51.4 ms | 81.0 ms | 281.8 | 36.72 MiB/s | - | 0 |
| list10k | 277.1 ms | 340.0 ms | 364.8 ms | 36.0 | 47.40 MiB/s | - | 0 |
| downloadViaApi | 14961.1 ms | 14961.1 ms | 14961.1 ms | 0.1 | 26.96 MiB/s | - | 0 |
| downloadDirect | 12797.3 ms | 12808.6 ms | 12809.6 ms | 0.1 | 51.23 MiB/s | - | 0 |
| uploadSmallBurst | 13.6 ms | 169.2 ms | 194.9 ms | 224.5 | - | 0.9 s | 1 |

Budgets:

| scenario | budget | status | detail |
| --- | --- | --- | --- |
| list1k | warm p95 < 100 ms | pass | 51.4 ms (budget < 100 ms) |
| list1kCold | cold < 400 ms | pass | 15.4 ms (budget < 400 ms) |
| list10k | warm p95, informational only | informational | 340.0 ms |
| downloadViaApi | throughput >= 90% of downloadDirect | fail | 52.6% of direct |
| uploadSmallBurst | wall time < 30 s | pass | 890.9 ms (budget < 30000 ms) |

### What these numbers mean

- **List scenarios comfortably clear their budgets.** `list1k` warm p95 (51.4 ms) is roughly half
  the 100 ms budget, and cold (15.4 ms) is well under the 400 ms budget, even against a real
  Postgres and SFTPGo rather than fakes. `list10k` (informational) sits around 340 ms warm p95 for
  a 10,000-entry unpaginated SFTPGo listing normalized and merged with tag/favorite data on every
  request; PLAN.md already expects this to need server-side caching and client virtualization
  rather than a raw budget, which is why it stays informational.
- **The download ratio budget (>= 90%) fails at ~53%, and that is expected right now, not a
  regression to chase.** Two costs stack on this dev machine that will not exist the same way in
  production:
  1. **Docker Desktop's networking.** SFTPGo runs inside Docker Desktop's linuxkit VM on macOS;
     every byte for both `downloadViaApi` and `downloadDirect` already crosses that VM boundary.
     `downloadDirect`'s own throughput (51.2 MiB/s) is itself far below what raw disk I/O could do,
     which is a sign the bottleneck here is Docker Desktop's virtualized networking, not the
     fdrive API.
  2. **The Node fetch stream pass-through.** `downloadViaApi` adds one more hop: the API fetches
     the file from SFTPGo with Node's `fetch`, then re-streams the `ReadableStream` back out
     through Hono/`@hono/node-server`. That extra stream stage, plus the API container's own
     Docker Desktop networking cost, is why it lands at about half of the direct number.

  PLAN.md §6 already anticipates this exact shape of problem: "Phase 5 has an optional zero-copy
  path: the API issues a short-lived signed URL and Caddy proxies downloads straight to SFTPGo
  after an `auth_request`-style check. Only built if the >= 90% budget fails." On Linux, without
  Docker Desktop's VM indirection (a plain container-to-container or host network), both numbers
  are expected to move closer together; this baseline should be re-measured against the actual
  Linux deployment target before deciding whether the zero-copy path is actually needed.
- **`uploadSmallBurst` finishes in under a second, far inside its 30 s budget**, but one of the 200
  uploads (`/burst/005.bin`) failed with a real, reproducible SFTPGo error: `Error checking parent
  directories`, surfaced by the API as a `502 upstream_unavailable`. This is six concurrent workers
  all racing to `mkdir_parents` the same brand-new `/burst` directory at once; SFTPGo's own mkdir
  path is not fully race-safe under that exact pattern (see the fake-vs-real contract work in
  `packages/sftpgo`'s "align fake with SFTPGo on mkdir conflicts" fix). It is not a bug in the perf
  harness or in fdrive's upload route: the request got a definitive HTTP response, which the
  harness correctly counted as an error. It reproduces occasionally, not every run, consistent with
  a directory-creation race rather than a deterministic failure. Given it is a pre-existing SFTPGo
  behavior outside this chunk's scope, it is documented here rather than "fixed" by, for example,
  pre-creating the directory (which would hide the real behavior a client of the API can hit).

### Reproducing or updating this baseline

Re-run `pnpm perf:quick` (or `pnpm perf` for the full, non-quick durations) and paste the new
tables into a new dated section above. Do not edit the numbers above in place; keep old baselines
for comparison across changes to the storage layer or the download path.
