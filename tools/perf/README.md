# Blocking performance harness

`pnpm perf:strict` runs every required scenario and exits nonzero for any failed,
missing, nonfinite, insufficient, degraded or incomplete observation. `pnpm perf`
also gates by default. `--diagnostic`, `--quick`, and `--only <scenario>` never
produce a full-gate pass; combining them with `--strict` is rejected.

Use Node 24, pnpm 10.11, Docker, and Chromium installed through
`pnpm --filter @fdrive/web exec playwright install chromium`. Stop unrelated heavy
work before a final measurement. The worker diagnostic may run under contention;
only the primary's quiet full run is release evidence.

The fixture starts disposable Postgres and the `ml` image the stack runs
(`ghcr.io/fredrikburmester/fdrive-ml:main`, pulled each run and recorded by digest) with
only its text unit on, and runs the API in process. The deterministic fixture is written
once to a temporary host folder, which the API serves as its local storage
(`FDRIVE_STORAGE_ROOT`, one home per user). The `perf` and `forbidden` users are created
directly in `app.local_users`, and full-text and semantic search are switched on in the
feature settings. Normal API session authentication remains active; no auth is injected.
No indexer runs: the API lists folders itself and search reads the index tables, which
the fixture fills directly, so no measured request reaches it. The direct download
baseline is a bare Node HTTP server streaming the same file from disk, so the API route
is compared with the same transport and no storage layer.

The search dataset contains 25,000 files and chunks in the measured identity,
plus a second identity's forbidden sentinels. Thirty-two realistic content
templates are embedded through the ml server's `intfloat/multilingual-e5-small` text
unit; those vectors are repeated across matching documents. This measures the real
query embedding call, database hybrid search, response processing and identity
scoping. It is not a claim that 25,000 independent documents were embedded. The
fixture runs `ANALYZE` before measurement.
The first run downloads the model (about 490 MB) into the named
`fdrive-perf-ml-models` Docker volume, which later runs reuse.

Measurements:

- Cold listing: 20 distinct, previously unrequested directories of 1,000 files.
- Warm listing/search: 20 warmups, then 100 complete requests each. The optional
  `--only list10k` API diagnostic is not a substitute for the browser gate.
- UI: isolated production Next build, five fresh browser contexts per list/grid.
  Injected resource and DOM observers record listing `responseEnd` to the first
  visible row's next animation frame, before Node waits for the JSON body. This
  initial ready mark excludes later driver roundtrips and navigation. Every sample
  must additionally verify 10,000 entries, native click selection, keyboard movement,
  scrolling to the last row, selection there, and Enter opening its preview. A failed
  action invalidates the sample. Fewer than 500 rows may be mounted. Diagnostic
  listing request counts/paths and browser long-task durations are retained for
  every completed sample; sibling-folder prefetch remains part of the workload.
- Download: 512 MiB, one complete warmup per route, three measured pairs alternating
  direct/API order. Every body is streamed to completion and byte-count checked.
  Throughput is completed payload bytes divided by summed transfer duration.
- Upload: 200 × 4 KiB via the authenticated app API, six concurrent streams. Timing
  ends after all upload responses complete. Subsequent listing and byte-for-byte
  download verification establish no missing/corrupt files. This is API burst
  timing; browser queue behavior is covered separately by functional tests.

Timestamped JSON under ignored `tools/perf/results/` contains environment, raw
samples, byte counts, failure reasons and every budget outcome. Cookies and
connection strings are excluded. Containers, child process groups, servers and
temporary files are cleaned after completion or partial startup failure. The named
`fdrive-perf-ml-models` Docker volume deliberately retains the downloaded model.

`pnpm test:perf:coverage` gates pure measurement validation, statistics, CLI,
bounded stream helpers and lifecycle scheduling. Docker/Next/browser orchestration
is exercised by the real diagnostic and strict runs. CI runs the strict suite as a
dedicated job and uploads observations even on failure. No production optimization
or budget relaxation belongs in this harness chunk.
