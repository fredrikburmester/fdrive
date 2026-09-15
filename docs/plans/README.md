# Plans

Only unfinished work lives here. Reviewed against source and delivery history on 2026-09-11.

| Document | Purpose |
| --- | --- |
| [Backup verification](BACKUPS.md) | Remaining gates for installation backups and isolated recovery |
| [Roadmap](ROADMAP.md) | Remaining requested features and acceptance criteria |
| [Followups](FOLLOWUPS.md) | Known fixes and outstanding verification |
| [Deferred](DEFERRED.md) | Explicitly deferred ideas and review recommendations |
| [Processing failures](PROCESSING-FAILURES.md) | Persistent per-file failures, accurate counters and targeted retries |
| [macOS writes](MACOS-WRITES.md) | Retention, recovery administration and native write beta qualification |
| [Stock storage writes](STOCK-SFTPGO-WRITES.md) | Finder writes on unmodified SFTPGo via fdrive-side serialization |
| [macOS beta qualification](MACOS-APP.md) | Signing, lifecycle and scale qualification for the native Finder app |
| [Pentest findings](PENTEST-FINDINGS.md) | Security triage list from the Shannon runs |

These are a backlog, not a claim that an agent is working on every item.

## Maintaining plans

- Add a concrete unfinished outcome, current behavior and completion criteria. Keep proposals
  distinguishable from accepted requirements; do not turn optional ideas into commitments.
- For substantial work, add a feature-named plan here and link it from this index. Avoid phase
  numbers and permanent worker-assignment files.
- On completion, move durable implementation details to developer docs and remove the
  completed plan or section. Extract unfinished sections first.
- Superseded designs are not backlog. Git history retains removed plans; do not maintain a
  second archive of obsolete implementation instructions.

Current behavior: [architecture](../ARCHITECTURE.md), [provider development](../STORAGE-PROVIDERS.md),
[scoping](../SCOPING.md), [authentication](../AUTH.md), [Office](../OFFICE-DEVELOPMENT.md)
and [System activity](../SYSTEM-ACTIVITY.md).
Workflow: [AGENTS](../../AGENTS.md).
