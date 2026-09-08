# Current handoff

Updated: 2026-09-08. Owner: primary agent.

## Continuous onboarding (verified)

- One shell-free `/setup` flow: claim → connection → administrator → six features → review.
  File-user verification establishes a session internally; only Finish enters the file browser.
  Reload resumes saved choices; other users skip the owner walkthrough.
- Explained WebClient file-user versus WebAdmin accounts and fdrive-only administrator rights.
  Removed SFTPGo inventory API/contracts/UI. Default home mapping; automatic storage checks
  only for enabled features, with collapsed correction settings when access needs attention.
- Reviewed/transferred inventory worktree; copy retained. Preserved unrelated user edits.
  Fixed transient feature-load resume bypass and unavailable probes remaining “Checking”.
- Passed final application lint/types/coverage, API/DB integration, and real-backend browser
  resume/skip-all/finish regression. Live dev: fresh claim, account, enable, automatic missing-
  mount notice, reload, both OCR choices, finish into files despite optional processing blocked.
  Disposable dev fixtures cleaned up; no live owner SFTPGo access or compatibility migration.
- Workflow helper regressions passed; final formatting fixed and documentation gate rechecked.

## LAN onboarding defaults (verified)

- User requires access from another device after init-env/update. Default web binding now
  all interfaces, with server-IP instructions; loopback remains an explicit override.
- Removed forced HTTPS assumption in core/Office proxies. HTTP default supports LAN cookies;
  FDRIVE_PROXY_SCHEME=https supports an HTTPS edge without trusting client protocol headers.
- Startup output directs users to the server IP and honors configured ports/URLs. Preflight
  validates the browser-facing protocol; init-env still generates only two required secrets.
- Passed: deploy coverage, deploy TypeScript, workflow, rendered Compose default binding,
  and real Caddy HTTP/HTTPS forwarding plus automatic cookie checks for core/Office variants.
  Initial Docker Desktop stale file mount was refreshed; existing workflow mock-start race
  passed on rerun. No remote Unraid configuration or SFTPGo data changed.

## Pre-release compatibility cleanup (verified)

- Removed feature upgrade script, environment activation, managed/unmanaged branches,
  compatibility UI, and related tests/docs. No existing installations need migration.
- One persisted feature configuration path; absent settings leave every feature off.
  Malformed worker settings leave processing off.
- Reviewed and transferred 22 Python paths from `.worktrees/p8-remove-legacy-workers`;
  copy retained. Unrelated user `.codex`/WORKING edits preserved.
- Passed: application lint/types/coverage; full API/DB integration; 12 browser checks against
  Next dev; dev UI inspection; workflow; Compose config; target runtime/OCR Python; Linux
  indexer 506 tests at 95.52%; final real SFTP rename/indexer integration recheck.
- No live owner SFTPGo access or user data migration performed.

## Setup walkthrough (implemented and verified)

- User requested UI-managed optional features, minimal deployment config, and guided SFTPGo
  connection/user diagnostics. Selected bundled workers, inactive until enabled.
- Design and acceptance criteria: [P8-SETUP-WALKTHROUGH.md](P8-SETUP-WALKTHROUGH.md).
- Integrated versioned feature settings/admission, resumable owner claim, SFTPGo diagnostics,
  walkthrough/System UI, lazy processing/models, and minimal deployment.
  Both OCR toggles are in onboarding. Reviewed worker deltas transferred; copies retained.
  Commit/push authorized; unrelated user edits preserved.
- Review fixes: bounded polling, cancellation without sweeps, durable derivative backfill,
  scanned-PDF extraction, model lifecycle/readiness, ARM wrapper,
  thumbnail-dialog completion independent of slow cache-size refresh, isolated Next builds.
- Passed: final application (1,860 API / 1,528 web tests plus workspace/deploy coverage),
  workflow, runtime/OCR Python (OCR 138 tests, 97.64%), focused regressions, final integration.
- Real dev UI passed: claim, connection, failed login/retry, admin user inventory, saved-step
  resume, all six choices, skip-all and finish into files. Fixture servers stopped.
- Actual production Compose passed: fresh all-off boot, idle model controllers, owner auth,
  writable OCR backup state, UI thumbnail enable -> generated 256/1024 previews -> authorized
  WebP 200; UI disable -> workers off, models stopped, thumbnail 404, cache retained.
  Production fixture containers/volumes removed; unused task images removed for disk space.
- Final Linux indexer passed 505 tests at 95.61% coverage with strict precision, including
  inotify. Final affected browser suite passed 12/12, including both rebuild dialogs.
  Docker Desktop stale-file/disk failures resolved without changing application data.
- All required profiles, including final documentation/workflow checks, passed. No live
  owner SFTPGo connection performed. Host mount changes still require deployment configuration,
  as explained in the walkthrough and deployment guide.

## README screenshots (2026-09-08)

- Added all 13 user-provided PNGs under `docs/screenshots/`, with a README overview
  and five expandable feature galleries. Original filenames and image bytes preserved.
- Image links, alt text, gallery markup, and scoped diff check verified; workflow gate
  passed. Included in the user-requested commit of all current changes.

## P7 folder views (complete)

- User selected Plan A and remaining recommendations: server pins per identity/path,
  exact-folder resolution, nullable future sort state, global-only virtual listings,
  rename/delete tracking, account reset across linked identities.
- Primary owns web hooks, toolbar/account controls, docs and target verification.
- Backend and virtual-view implementers integrated after diff review and scoped transfer.
  Copies retained in `.worktrees/p7-folder-view-backend` and `.worktrees/p7-virtual-views`.
- Global default retains `fdrive.view` in this browser. Folder pins sync across devices.
- Target workflow, application (lint/typecheck/coverage), and integration passed. Application
  used `TURBO_CONCURRENCY=1` and permitted socket access; no gates weakened.
- Live dev smoke on isolated ports 3004/3005 verified saved Grid on `/photos`, default List
  on `/docs`, persistence, unpin, and account controls. Restored the temporary pin; stopped
  owned servers, preserved existing dev processes.
- Browser: five new feature scenarios passed, including another browser, mobile, rollback,
  rename/reset, and virtual listings. Corrected ambiguous existing View selectors; thumbnail
  harness uses an explicit image fixture because its fake indexer generates no thumbnails.
- All 54 affected browser scenarios passed across the initial run and corrected spec reruns.
  Backend/virtual worker copies remain retained. Logs: `.fdrive-workflow/logs/` (ignored).

## Workflow simplification (complete)

- Requested changes integrated and verified; baseline `e791fd5`. Three workflow worktrees
  reviewed, byte/mode-verified against target, then removed. Other task worktrees preserved.
- Native optional delegation; compact shared docs/roles; recovery and history loaded on demand.
  Terra/high configuration and explicit Astra/low approval policy preserved.
- Helpers: compact PASS/FAIL with retained logs; Python venv/dev readiness setup; working-tree
  baselines before setup; scoped conflict-safe uncommitted transfer with diff/check modes.
  CI shares setup/verification commands and uploads only helper logs on failure.
- Target `workflow` PASS: 32 command +8 environment +19 integration-helper +11 transfer
  regression groups; shell/Python/TOML syntax, lint, diff checks. CI YAML and docs links pass.
- Real core profile PASS: 292 tests, existing coverage intact. Quiet89 vs verbose1611 bytes
  (94.5% less output); shared docs/roles ~60% fewer words. Evidence in ignored
  `.fdrive-workflow/evaluation/`; full gate logs under `.fdrive-workflow/logs/`.
- Hosted CI not run locally; new role text takes effect when the runtime reloads configuration.
  Dev lifecycle tested with fixtures and occupied-port smoke; existing live servers preserved.

## Search startup recovery (2026-09-08)

- User requested automatic recovery after deployment without page reload.
- Implementer completed search contracts/API/UI/tests in `.worktrees/search-startup-recovery`,
  branch `codex/search-startup-recovery`; baseline committed HEAD, no copied prerequisites.
- Add transient scope reason and bounded polling while open; preserve scope authorization.
- Reviewed scope and production diff; committed as `af0a3d9` after user requested commit/push.
- Live dev verification: stopped local `fdrive-dev-indexer-1`, observed startup message;
  restarted indexer and saw text plus visual results for unchanged `readme` query without reload.
- Workflow, target application (lint/typecheck/coverage), and integration passed.
- Target search browser suite passed 17/17, including startup message and unchanged-query
  recovery. Logs: `/tmp/fdrive-startup-{application-final,integration,browser-final}.log`.
- Complete. Worker checkout removed after exact file comparison and target gates.
  Unrelated concurrent workflow changes preserved.

## Product state

- Latest search/file-browser UX merged and verified; no outstanding UX work. Prior target
  application/workflow gates passed and affected browser suite passed 31/31.
- Phase 5 strict performance gate previously passed: search25k p95 195.82 ms (<300),
  zero errors; detailed evidence in archive.
- Earlier P5 worktrees were retained by the preceding task. Do not clean them without review.
- Full prior evidence, performance work, and historical handoffs: [archive](STATUS-history.md).
  Product scope and architecture remain in [PLAN.md](../../PLAN.md).
