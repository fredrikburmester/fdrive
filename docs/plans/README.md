# Plans

Only unfinished work lives here. Reviewed against source and delivery history on 2026-09-11.

| Document | Purpose |
| --- | --- |
| [Roadmap](ROADMAP.md) | Remaining requested features and acceptance criteria |
| [Followups](FOLLOWUPS.md) | Known fixes and outstanding verification |
| [Deferred](DEFERRED.md) | Explicitly deferred ideas and review recommendations |
| [macOS gaps](MACOS-GAPS.md) | Orphaned pairing credentials, disabled-extension and stalled-enumeration status, staging retention, conflict-name retries |
| [Processing failures](PROCESSING-FAILURES.md) | Persistent per-file failures, accurate counters and targeted retries |
| [macOS writes](MACOS-WRITES.md) | Retention, recovery administration and native write beta qualification |
| [macOS beta qualification](MACOS-APP.md) | Signing, lifecycle and scale qualification for the native Finder app |

These are a backlog, not a claim that an agent is working on every item. Current work and
uncommitted changes belong in [STATUS](../workflow/STATUS.md).

## Maintaining plans

- Add a concrete unfinished outcome, current behavior and completion criteria. Keep proposals
  distinguishable from accepted requirements; do not turn optional ideas into commitments.
- For substantial work, add a feature-named plan here and link it from this index. Avoid phase
  numbers and permanent worker-assignment files. Track temporary ownership in STATUS.
- On completion, move durable implementation details to developer docs, record verification
  in history, and remove the completed plan or section. Extract unfinished sections first.
- Superseded designs are not backlog. Git history retains removed plans; do not maintain a
  second archive of obsolete implementation instructions.

Current behavior: [architecture](../ARCHITECTURE.md), [provider development](../STORAGE-PROVIDERS.md),
[scoping](../SCOPING.md), [authentication](../AUTH.md), [Office](../OFFICE-DEVELOPMENT.md)
and [System activity](../SYSTEM-ACTIVITY.md).
Delivery evidence: [history](../workflow/STATUS-history.md). Workflow: [WORKING](../../WORKING.md).
