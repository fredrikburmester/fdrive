# P2-CLEAR-JOBS

Scope: PLAN.md sections 7, 9, and 13. Three isolated implementers; no model overrides.

## Fixed contract

- Internal `POST /index/clear`: optional `{root, path}`; path requires root. Empty body means all configured roots. Reject malformed JSON, wrong types, empty names, unknown roots, and traversal. A leading slash means root-relative; `/` means the whole root.
- Internal `POST /thumbnails/clear`: empty object or empty body only; clears the shared cache globally.
- Both return HTTP 202 `{started: true}` immediately after admission. Candidate discovery and deletion happen in the background. Return 409 when any clear or thumbnail rebuild is active. Preserve existing rebuild interfaces.
- Internal `/stats` adds optional `index_clear` and `thumbnail_clear`, each with the existing rebuild progress shape: running, processed, total, started_at, finished_at, errors. Record top-level failures as errors and release admission in finally, including thread-start failures.
- Public admin-only `POST /api/v1/system/indexer/clear` (`ROUTES.system.indexerClear`) and `POST /api/v1/system/thumbnails/clear` (`ROUTES.system.thumbnailsClear`). Export `IndexerClearRequest`, `IndexerClearResponse` ({started: boolean}), and `IndexerClearJob` (existing progress shape) from contracts. `IndexerStats` adds optional `indexClear` and `thumbnailClear`.
- IndexerClient adds `clearIndex(options?: {root?: string | undefined; path?: string | undefined})` and `clearThumbnails()`. Proxy validation failures as 400, unknown roots as 404, busy as 409, service failures as 502.
- The shared public client in packages/contracts adds `systemClearIndex(req?: IndexerClearRequest)` and `systemClearThumbnails()`; API/contracts worker owns their tests too.
- Keep GET thumbnails compatible. Web can use the existing indexer summary to get roots, reachability, and progress. Retain both rebuild routes for compatibility.

## Data semantics

- Index clear removes selected idx.files rows and cascading idx.chunks/embeddings. Preserve roots, scan/event/move history, all app metadata, thumbnail cache, and original files. Match exact file or directory boundary, never a LIKE wildcard. Reuse path locks to coordinate active extraction and embedding writes; no index-wide transaction held for the entire pass. Do not wake an immediate rescan. Later scheduled scans or watcher changes can repopulate the index; state this clearly in UI.
- Thumbnail clear removes manifest previews plus recognized orphan preview files in the configured cache; never traverse symlinks or unlink outside that cache. Preserve original files and all text/index/metadata rows. Remove manifest rows only when corresponding removal succeeded or the file was already missing. Keep failed items available for retry. Report errors. Normal indexing/on-demand generation can repopulate previews. Coordinate with explicit rebuild admission.
- Each background thread obtains its own database connection. Bound iteration/batches where practical; no large discovery in an HTTP handler.

## Web

- Move thumbnail count/progress, scoped root/path rebuild and force control entirely from Indexer to Thumbnails. Remove the reindex thumbnail toggle. Keep existing API compatibility.
- Add confirmed clear-cache action to Thumbnails and confirmed scoped clear-index action to Indexer. Explain exactly what gets removed, what stays, and eventual regeneration. Show running/completed/error counts; disable conflicting actions while pending/running, handle 409, and keep polling.
- Every Indexer settings field gets a useful one-line description. Reuse existing shadcn components and tokens.

## Ownership and gates

- indexer: services/indexer/** and docs/INDEXER.md. Python ruff, strict mypy, full Docker pytest with 95 percent coverage; regression coverage for scope, data preservation, failure/retry, admission, concurrency and filesystem confinement.
- api: packages/contracts/**, apps/api/src/system/**, apps/api/test/** only where existing IndexerClient fixtures need updating. Tests for admin restrictions, body validation, mapping, optional old stats, and new stats. Node 24, package lint/typecheck/coverage and relevant container integration.
- web: apps/web/**. API client/hooks, forms and progress, unit coverage and system e2e including cancel, payloads, busy and completion. Node 24, lint/typecheck/coverage. Parent runs full e2e after integration, sequentially with Turbo tasks.
- WORKING.md and AGENTS.md are copied prerequisites in worker checkouts; preserve them. They are excluded from product transfer and cleanup requires byte comparison.
- Parent reviews and transfers verified diffs without commits, preserving the pre-existing uncommitted Codex migration. No worker Git mutations, stash, recursive delegation, or edits outside ownership.
