# Plans

Only unfinished work lives here. Reviewed against source on 2026-11-14, after SFTPGo, WebDAV
and S3 storage were removed.

| Document | Purpose |
| --- | --- |
| [Backup verification](BACKUPS.md) | Real S3 and host cutover checks and two capture follow-ups for installation backups |
| [Roadmap](ROADMAP.md) | Remaining requested features and acceptance criteria |
| [Followups](FOLLOWUPS.md) | Known fixes and outstanding verification |
| [Deferred](DEFERRED.md) | Explicitly deferred ideas and review recommendations |
| [Processing failures](PROCESSING-FAILURES.md) | Persistent per-file failures, accurate counters and targeted retries |
| [macOS writes](MACOS-WRITES.md) | Deployment and release qualification of native writes |
| [macOS beta qualification](MACOS-APP.md) | Signing, lifecycle and scale qualification for the native Finder app |
| [AI chat](AI-CHAT.md) | A docked, persistent chat panel that files are dropped into, with approval-gated tools, building on AI organize |
| [Owned shares](OWNED-SHARES.md) | Server-side gallery gating for share links from unindexed logins |
| [ML server follow-ups](ML-SERVER.md) | What is left after moving embeddings and document extraction into one Rust server: amd64 measurements, memory, extraction gaps |
| [Encryption](ENCRYPTION.md) | Host encryption at rest, and end-to-end encrypted folders with one password in the web app and FDrive for Mac; decided, not started |

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

Current behavior: [architecture](../ARCHITECTURE.md), [storage port](../STORAGE.md),
[scoping](../SCOPING.md), [authentication](../AUTH.md), [Office](../OFFICE-DEVELOPMENT.md),
[System activity](../SYSTEM-ACTIVITY.md) and [personal activity](../ACTIVITY.md).
Workflow: [AGENTS](../../AGENTS.md).
