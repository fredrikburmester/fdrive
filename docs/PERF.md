# Performance

The [blocking harness](../tools/perf/README.md) is the current reference for fixtures,
commands, sample validity and environment requirements. `pnpm perf` and `pnpm perf:strict`
gate by default. Diagnostic, quick and single-scenario runs are not full-gate evidence.

## Budgets

| Measurement | Required result |
| --- | --- |
| 1,000-entry warm listing | p95 <100 ms |
| 1,000-entry cold listing | p95 <400 ms |
| Search over 25,000 indexed files | p95 <300 ms |
| 10,000-entry list and grid | Ready <500 ms after data arrival; bounded DOM and interaction checks |
| Download through API | At least 90% of direct upstream payload throughput |
| 200 small uploads, six streams | <30 seconds, complete integrity verification |

Executable decisions live in [budgets](../tools/perf/budgets.ts). Do not relax them to fit
results. The optional list10k API diagnostic does not replace the browser measurements.

Run with Docker and the browser dependencies available:

```sh
pnpm perf:strict
```

Results and environment metadata are written to ignored `tools/perf/results/`. Use a quiet
full run for final evidence.
The separate 2 GiB/RSS requirement remains in [followups](plans/FOLLOWUPS.md).
