# Inconsistency audit dispositions

Initially validated against `6e9f2ce`, then integrated with main `7462d7f` in branch
`codex/inconsistency-audit-20260912`, worktree `/private/tmp/fdrive-inconsistency-audit`.
Original checkout WIP is excluded.
The supplied report repeats some findings across categories; each appears below.

## Defaults, deployment and tooling

| Finding | Disposition |
| --- | --- |
| OCR excludes disappear on unrelated settings save | Fixed API fallback to `Programs/**`, `Photos/**`, `Videos/**`, matching the worker. Regression covers read/save and intentional saved `[]`; existing settings remain authoritative. |
| System activity listed as unstarted | Updated tracked STATUS from awaiting review to merged. The committed plans index already omits the proposal. The reported untracked proposal and its uncommitted references exist only in the original checkout and were not copied or modified. |
| Setup token rejected by preflight | Added to generated allowlist and explicit compose secret injection; preflight regression accepts it. |
| image-embed/runtime absent from CI | Both included in path filters and Python job matrices in services/full workflows, using existing setup/verification gates. |
| Dev tool tests omitted | Added dev Vitest config and typecheck; application coverage command and tools suite run them. |
| API env example stale/removed public URL | Generated complete API reference from the config catalog, including optional cookie semantics. A diff test prevents drift. |
| Unused worker tokens | Removed only indexer/OCR injections; runtime controllers retain authentication. |
| Office overrides inert | Compose passes product, server, public and WOPI URLs, retaining bundled defaults. The public URL also reaches the web build for its iframe CSP. |
| Two image embedding batch knobs | Indexer uses `IMAGE_EMBED_REQUEST_BATCH_SIZE`, retaining the old name as a fallback. Server `IMAGE_EMBED_BATCH_SIZE` still controls inference microbatches. |
| Dev ports disagree with generated URLs | Fresh API/web env generation reads matching `FDRIVE_DEV_*` overrides. Tika publishes a configurable dev port. Existing customized env files are preserved; changing ports later requires updating them as documented. |
| Provider tests omitted from typecheck | Included SFTPGo/WebDAV test directories; fixed an uncovered exact-optional-property fixture error. |
| Root unit test skips office/perf | Added both projects with explicit roots so root and direct commands discover the same suites. |
| Python aliases call bare pytest | Aliases use the Python verification helper and prepared service venvs, including Linux inotify coverage on macOS. |

## Contracts and shared rules

| Finding | Disposition |
| --- | --- |
| Share views/downloads/uploads names differ | Documented provider transfer-token semantics in contracts, schema and architecture. Existing column/API names retained for compatibility; thumbnails do not spend transfer tokens. |
| Trash ID is a path | Opaque provider ID by contract; recycle-folder implementation uses a relative trash path. Documented rather than changing clients to assume a universal path. |
| Job `id` duplicates `jobId` | Documented compatibility alias; both values remain identical. |
| Internal SystemEvent versus public SystemLog | Documented persistence versus aggregated API projection. |
| Scope has two meanings | Documented separate typed path mappings and share permissions. |
| Health missing from ROUTES/client | Added route constant and typed `ApiClient.health()`, with validation test. |
| MCP uses src/dst and tag names | Intentional task-oriented interface: translates paths and creates named tags; REST consumes tag IDs. Documented in MCP.md; no breaking rename. |
| Hand-built public-share subroutes | Shared named suffixes and route builder now used by API, typed client and browser upload client. |
| Undeclared identity query | Exported GET/HEAD query constant and documented owned-identity selection, duplicate/header conflict rejection. A session/token still authenticates; the query is not a credential. |
| Misattached route comments | Corrected job and rebuild response documentation. |
| Archive default filenames disagree | Shared core stem helper used by API and UI, including compound extensions, dotfiles and multi-selection. |
| Image extension lists/AVIF | Browser preview derives from the gallery set plus intentional SVG/ICO additions. Indexer recognizes AVIF; Pillow minimum guarantees decoding, tested with a real AVIF file and both thumbnail sizes. |
| Unsupported archive previews | Shared peek eligibility matches extractable containers; bare gzip and unsupported formats fall back to download. |
| Copied Python feature/settings parsers | Retained service-local parsers: indexer/OCR ship as independent Python packages/images. Corrected demonstrated OCR fallback drift; no new shared runtime package/deployment dependency introduced merely to eliminate matching code. |
| Repeated canonical UUID rules | Share IDs and Office rule provider IDs reuse CanonicalUuid. Ordinary response/token UUID validation retains its existing case acceptance; canonical input selectors remain strict. |
| Three relative-time formats | Intentional display contexts: compact system elapsed time, localized preview relative time, calendar labels with clock times in file listings. Existing tested presentation preserved. |

## Persistence, jobs and service boundaries

| Finding | Disposition |
| --- | --- |
| Deleted files appear in error logs | Filtered `deleted_at` in derived worker error events; integration regression. |
| filesByIds returns deleted rows | Active-only lookup matches sibling queries; integration regression. |
| Migration-only search indexes missing in Drizzle | Declared five GIN/HNSW indexes; generated migration/snapshot 0005. Idempotent CREATE preserves existing indexes while adding the lock expiry index. |
| WOPI no FK/expiry cleanup | Added bounded, indexed opportunistic expiry cleanup with row locking/skip-locked semantics. Retained opaque text IDs required by generic WOPI repository; Office routes resolve/authorize durable file IDs first. Integration tests cover expiry and concurrency. |
| Successful extraction warnings hidden | Done-job warnings now visible and wrap in Activity; failed jobs retain error styling. |
| Image maintenance ignores active workers | Rebuild and clear snapshots both disable maintenance actions. |
| OCR/reindex/reembed 409 becomes 502 | Preserve conflict status and explain busy/disabled processing rather than unreachable service. |
| Image warm-up shown as unreachable | Preserve worker loading status through API/UI; loading blocks maintenance. |
| Cancelled counted as finished | Activity title counts cancellations separately. |
| Claimed idx.events replay | Docs now state re-LISTEN without replay; missed notifications are lost and re-query reads current state. |
| Rebuild discovery exceeds admission timeout | Claim job and acknowledge 202 before inventory scan. Background discovery exposes unknown totals honestly, then updates stats/activity. Blocking-inventory HTTP tests prove admission/409 behavior. New clients accept both nullable totals and older numeric worker responses; external clients must handle the new null admission total. |
| MCP extraction has no timeout | Added the same 30-second abort signal as byte extraction. |
| Feature probes hardcode controller ports | Explicit optional runtime-controller URLs; direct worker probes when unset. Generated dev URLs retain published ports, and direct workers need no controller revision. The deployment readiness script also honors the configured Tika controller URL. |
| Image readiness differs across System pages | Features also checks actual model health after controller readiness; loading remains preparing, and a starting controller does not require its absent child to answer yet. |
| image_embeddings stats dropped | Preserve the count in the API client, with regression. |

## Documentation corrections

Architecture lists shipped SFTPGo and WebDAV adapters; importer filename uses
`import_filesai.py`; quickstart uses authenticated SSH and notes repository access;
contributing follows core coverage thresholds. Fixed COMMANDS anchor, deleted Office
compose reference, all three Dockerfile pin comments, historical hardening-reference
wording and trash fixture path. Production instructions use ordinary compose startup
and persisted feature activation; only dev compose uses `--profile index`.

## Verification

Passed on 2026-09-13:

- Application: lint, all package/tool typechecks and coverage gates. The complete rerun
  used `VITEST_MAX_WORKERS=1` after the initial concurrent web run timed out; no thresholds
  changed. API 2,182 tests, web 1,828, all remaining packages and dev/office/perf/deploy tools pass.
- Integration: 458 tests across database, API, testkit, SFTPGo and WebDAV. Fresh migrations
  and a repeated migration both pass; a subsequent Drizzle generate reports no schema changes.
- Python: integrated indexer 568 tests, 95.43% coverage including Linux inotify; OCR 146 tests, 97%;
  image-embed 74 tests, 100%; runtime 42 tests, 97%. Ruff and mypy pass for all four.
- Browser: all 39 selected cases pass against the production build, including archive,
  preview, public shares, System, activity and the new audit regressions.
- Live Next dev app with disposable PostgreSQL/SFTPGo and controlled worker health:
  model loading and unknown-total discovery display correctly and disable maintenance;
  direct worker health on published ports agrees with Features readiness. Light-mode
  production screenshots and dark-mode live UI inspected; completed warnings wrap visibly
  and cancellation totals remain separate.
- Generated compose evaluated with fixture overrides: Office API values and web CSP build
  argument agree, setup token propagates, and every runtime controller retains its credential.
  Root Vitest discovery includes dev, office and perf; changed Markdown links and diff check pass.

Workflow profile passes: orchestration regression groups, shell/Python syntax, agent definitions, lint and diff check.

Docker initially exhausted its 80 GB disk: PostgreSQL exited during initdb before worker
checks could run. Reclaimed 1.87 GB unused build cache, older unreferenced untagged image
builds and this audit's superseded image. Existing containers, tagged images, volumes and
stored data were preserved. Subsequent complete worker and browser runs pass.

Main integration retains the newer nested Features navigation, thumbnail outcome accounting,
and deployment readiness checks. Thumbnail regressions use the new asynchronous admission
result; a deployment regression covers the configured Tika runtime port and path.
The integrated application gate passes, including 84 deployment-tool tests; all 39 browser
cases, the full indexer gate, all 458 database/storage integration tests, and deployment
tooling typechecks pass again. Live Next dev verification also passes through the nested
Features navigation: model loading, unknown-total discovery, disabled maintenance actions,
and healthy worker readiness agree. Final workflow verification passes.

Committed to local main on user request; original checkout WIP preserved. No push or deployment.
Integrated logs: `.fdrive-workflow/logs/step.adBUvE/` (application coverage),
`step.4fj5Rw/` (indexer), `step.GIKa6j/` (browser), `step.AA8ymI/` (integration),
and `step.DUKFkZ/` (live dev fixture).
