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
| [macOS beta qualification](MACOS-APP.md) | Signing, lifecycle and scale qualification for the native Finder app |
| [AI chat](AI-CHAT.md) | A docked, persistent chat panel that files are dropped into, with approval-gated tools, building on AI organize |
| [Personal activity](RECENT-ACTIVITY.md) | A durable personal history answering where an upload went and what has happened to a file since, with [events](RECENT-ACTIVITY-EVENTS.md), [schema](RECENT-ACTIVITY-SCHEMA.md) and [coverage](RECENT-ACTIVITY-COVERAGE.md) |
| [Owned shares](OWNED-SHARES.md) | fdrive-served share links: done; server-side gallery gating for unindexed logins remains |
| [Local storage](LOCAL-STORAGE.md) | fdrive serves a folder on its own disk with its own users, its only storage since SFTPGo, WebDAV and S3 went: decisions and what comes later |
| [ML server follow-ups](ML-SERVER.md) | What is left after moving embeddings and document extraction into one Rust server: amd64 measurements, memory, extraction gaps |

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

Current behavior: [architecture](../ARCHITECTURE.md), [storage port](../STORAGE-PROVIDERS.md),
[scoping](../SCOPING.md), [authentication](../AUTH.md), [Office](../OFFICE-DEVELOPMENT.md)
and [System activity](../SYSTEM-ACTIVITY.md).
Workflow: [AGENTS](../../AGENTS.md).
