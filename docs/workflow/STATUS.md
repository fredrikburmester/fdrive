# Current handoff

Updated: 2026-09-10. Owner: primary agent.

## P10 PR reduction (2026-09-10, verified)

- Implemented directly on `claude/p10-storage-providers`; existing isolation and pentest
  edits preserved. Refactor committed on request; no push requested.
- Canonical memory storage lives at `@fdrive/core/testing`, re-exported by testkit; its
  tests moved with it. Shared HTTP dispatch, derived request schemas, SFTPGo user runner,
  setup guard/claim persistence, provider fixtures, mutation invalidation and field inputs
  replace repetition. Removed unused browser action sets; table-driven form tests.
- Recovery fixed unfinished JSX/type errors and restored memory move conflicts, bounded
  probe streaming, setup race/restart tests, and unchanged query invalidation behavior.
- Plan adjustments: kept endpoint comparisons and post-login ownership rechecks (isolation),
  the explicit setup login entry point, and capability props (avoid a query subscription
  per file row). Kept separate conformance cases and simple dialog state/copy; extra helpers
  there add indirection without meaningful savings. Kept typed repository patches and config
  copying. Configuration validation moved to service.
- Passed: application (lint, types, all coverage); final API/core package rechecks;
  integration (DB 267, API 35, SFTPGo 72, testkit 9); affected production browser 16/16;
  real Next dev storage flows 3/3. No gates lowered.
- Evidence: `.fdrive-workflow/logs/step.6shFUF/` (application coverage), `step.7cJuDQ/`
  (final API), `step.ZJmbzL/` (final core), `step.qGPRxL/` (integration), `step.BSK3fD/`
  (production browser), `step.U16joC/` (dev browser). Roughly 1,100 net application/package
  lines removed versus HEAD, counting new shared fixture/tests and existing follow-up edits.

## P10 provider isolation review fixes (2026-09-10)

- Branch `claude/p10-storage-providers`: env administrator grants now require the configured
  SFTPGo endpoint; remote providers require explicit index mappings; PostgreSQL row locks
  serialize address changes with verified login/link persistence; a durable setup marker
  preserves access after disabling the final provider.
- Regression coverage includes all four findings, stale verified credentials and concurrent
  first login/link versus address changes on real PostgreSQL, plus disable/reload/re-enable
  through the storage UI. Provider-binding integration fixtures now declare their env admin
  endpoint and indexed scope explicitly (mock indexer directory; two distinct HTTP upstreams).
- Passed: workflow, final lint/typecheck; coverage for all eight packages and Office/perf/deploy tools;
  integration suites (SFTPGo 72, testkit 9, DB 267, API 35); affected production browser flows
  12/12 and real dev-app storage flows 3/3. Initial parallel coverage timed out in a large-trash fixture; serial package runs
  passed with existing thresholds/timeouts. Integration fixture failures passed after correction
  in a targeted 14/14 provider-binding rerun.
- Evidence: `.fdrive-workflow/logs/step.Zmlmif/` (web coverage), `step.t6aNoB/` (other coverage),
  `step.tgdZzi/` (integration), `step.bPWhf5/` (binding rerun), `step.2CEHHN/` (browser),
  `step.Gp718l/` (dev browser).
- Unrelated pentest edits and `PR-REVIEW-FINDINGS.md` remain outside this change.

## P10 storage providers: A2 capabilities in the web (implemented 2026-09-10)

- Spec [P10-CAPABILITIES-WEB.md](P10-CAPABILITIES-WEB.md), "As implemented" section lists the
  deviations. The file browser, login and account halves were done in the main checkout
  (commit `9b89489`); System > Storage came from one `implementer` worktree
  (`claude/p10-system-storage`) transferred with `transfer-checkout.sh` after rebasing it onto
  that commit.
- Delivered: `lib/identity/capabilities.ts` (`capabilitiesFor`, `anyLoginCan`, `browserActions`,
  `planDownload` in `lib/files/download.ts`); one `capabilities` prop on the context menu,
  toolbar, list, grid, virtual listings and Inspector; sidebar Shares/Trash as the union across
  logins with a per-type `ProviderIcon`; login page over `GET /providers` with
  `ProviderFieldInputs` and a `ProviderPicker` for several providers; Add/Remove login dialogs
  rendering the provider's fields with relabelled confirmation fields; scope card gated on
  `scopeMapping`; provider-neutral scope copy; `/system/storage` (list, add, test, edit,
  enable/disable, remove) and General reduced to server address + Trash; Trash settings save
  now invalidates `auth.me` so the capability follows the setting.
- Passed on `main`: web unit suite with coverage; `application` for the first half; browser
  (`--workers=1`) `auth`, `login-providers`, `about`, `account-identities`, `account-scope`,
  `smoke`, `file-controls`, `trash` 21/21 on the first half, and in the worker worktree
  `system` + `system-storage` 13/13 (real API and SFTPGo). After the transfer, on `main`:
  `application` (lint, typecheck, coverage) and browser `system`, `system-storage`,
  `login-providers`, `features` with `--workers=1`, all passing; `workflow`.
- Known: no capability can be false for an SFTPGo login except `trash`/`office`/`index`/
  `scopeMapping` through configuration, so the per-flag hiding is covered by component tests
  (`capability-gating.test.tsx`), not browser specs. Next: B (WebDAV, [P10-WEBDAV.md](P10-WEBDAV.md))
  and D (owned shares, [P10-SHARES.md](P10-SHARES.md)) in parallel.
- Worktree: main checkout, branch `main`; the `p10-system-storage` worktree can be removed once
  the transfer commit is in.
- Review (PR #1, `claude/p10-storage-providers`): ten confirmed findings fixed on 2026-09-10,
  listed under "Review fixes" in [P10-REGISTRY-API.md](P10-REGISTRY-API.md) (disabled provider
  keeps sessions alive, public label never the host, setup writes config after login, address
  equality after upstream login, seed keeps/retires rows, duplicate address 409, office_files
  cascade, per-row `index`, delete dialog reads the capability).

## P10 storage providers: A1 registry and generic auth (implemented 2026-09-10)

- Design [P10-STORAGE-PROVIDERS.md](P10-STORAGE-PROVIDERS.md); chunk spec
  [P10-REGISTRY-API.md](P10-REGISTRY-API.md) with an "As implemented" section listing the
  deviations. Implemented directly in the main checkout, no worker worktrees.
- Delivered: `ProviderModule` port and field validation in core, `stat`/`ifRange`/optional
  `zip`+`setModifiedAt` on `StorageProvider`, `withMoveToTrash`; `app.providers` gains
  `label`/`config`/`enabled`/`managed_by_env` (migration `0009_providers`); `SFTPGO_URL` seeds
  and pins the SFTPGo row at startup (`ProviderService.seedFromEnvironment`), nothing else is
  migrated (pre-release, no compatibility with the old `connection.sftpgo` setting);
  `packages/sftpgo` exports `sftpgoModule` (adapter, probe and 401 retry moved in from the API);
  `@fdrive/testkit` exports the canonical `createMemoryStorage` and `describeStorageProvider`
  (runs against memory, the SFTPGo fake, and the real SFTPGo container in
  `packages/sftpgo/test/integration/container.contract.test.ts`, 72/72); API: `providers/{registry,service,routes}`, generic
  `TokenSource`, `verifyCredentials`, `createPinnedStorageFactory` for Office, `unsupported`
  error kind, `/providers` and `/admin/providers*` routes replacing `/admin/connection`;
  contracts: `LoginRequest { providerId?, credential }`, `LinkIdentityRequest { providerId?,
  credential, currentCredential }`, `IdentitySummary.capabilities`, `AboutResponse.builtOn[]`
  and `providers[]`, `AdminProvider*`; web: minimal adaptation only (login form, link/unlink
  dialogs, About, System > General over `/admin/providers`); A2 followed the same day.
- Passed on `main` checkout: `application` (lint, typecheck, coverage: api 99.03% statements),
  `workflow`, `integration` for all files except the two known pre-existing failures
  (`sftp-rename.test.ts` Docker pull of `python:3.12-slim` hangs; `provider-binding.test.ts`
  "api-token: isolates mutation" barrier flake, also on unchanged `main`). The other eight
  provider-binding cases pass against two live upstreams with provider rows disabled/added through
  `/admin/providers`. Browser (production build, `--workers=1`): `system`, `auth`,
  `account-identities`, `about`, `smoke` specs 21/21.
- Semantics to know: a stored credential never follows a configuration change because identities
  are bound to rows; re-addressing a row that logins use is refused (`conflict`), env-managed rows
  refuse address changes and deletion, and `verifyCredentials` re-checks the row after the
  upstream login. With several enabled providers a login must name `providerId` (400 otherwise);
  setup creates the SFTPGo row disabled and enables it after the owner login.
- Not done in A1: `roots[].sftpgoPath` keeps its name; core keeps its own memory fake (cannot
  depend on testkit); no page shows the new `general` event log subsystem; the conformance
  suite accepts `upstream_unavailable` as well as `bad_request` for listing a file, because real
  SFTPGo 2.7.5 drops the connection there. Next: A2 ([P10-CAPABILITIES-WEB.md](P10-CAPABILITIES-WEB.md)), then B and
  D in parallel.
- Worktree: main checkout, branch `main`.

## P9 System settings restructure and event log (committed 2026-09-09)

- Spec: [P9-SYSTEM-SETTINGS.md](P9-SYSTEM-SETTINGS.md). Two `implementer` worktrees
  (`claude/p9-system-web` for `apps/web`, `claude/p9-event-log` for db/contracts/api) merged
  with `merge-chunk.sh`; the `LogSheet`, its hook and the page mounts were added directly in
  the main checkout afterwards.
- Web: Features is toggles only (six cards with "Open" links plus an Office card); Connection
  became General (`/system/general`, old URL redirects); new Shared folders and Office pages;
  Indexer and OCR settings live in a `SettingsSheet` with a discard guard; `SystemPage` gates
  on `feature` ids instead of the page title; every feature page has a Logs sheet with level
  filter, copy, .txt/.ndjson download and "Load older". The Indexer "Recent errors" list is gone.
- API: `app.system_events` (migration `0008_system_events`), `GET /api/v1/system/{subsystem}/logs`
  merging `idx.scans`/`idx.files` errors and `idx.ocr_runs`/`idx.ocr_log` failures; events are
  recorded for settings saves, maintenance requests and failures, feature toggles, worker
  reachability transitions and Office settings saves.
- Passed on `main`: `application` (lint, typecheck, coverage) and browser `system`, `features`,
  `office-settings`, `trash`, `account-scope` specs with `--workers=1`. In the event-log
  worktree: `@fdrive/db` integration 10/10 (migration and the merge query) and
  `composition.test.ts`. Two API integration tests fail there and on unchanged `main` alike:
  `sftp-rename.test.ts` (Docker credential helper hangs on `python:3.12-slim` pull) and
  `provider-binding.test.ts` "provider barrier was not reached" (reproduced on `main`).
- Known: the five browser specs race each other at the default two workers (onboarding
  specs reset `walkthroughComplete`, and the clear tests share the fake indexer's busy state);
  pre-existing, run them with `--workers=1`. The walkthrough's Office step label is still
  the literal "ONLYOFFICE" regardless of product.
- Not done: no real dev-stack pass yet (the browser specs run against the production build
  with a fake indexer).

## P8 virtual folder index support (in progress, uncommitted)

- Spec: [P8-VIRTUAL-FOLDERS.md](P8-VIRTUAL-FOLDERS.md). Implemented directly in the main
  checkout (no worker worktrees): VF-1, VF-2, and VF-3 together.
- Step 0 evidence (dev stack, indexer container started for this): carol's scope status was
  `unavailable`/`mismatch` and `/api/v1/search/status` reported `mismatch`; alice's scope
  status was `available`/`ok`. Reproduced before any change.
- Contract deltas beyond the spec, both needed by the editor: the status also returns the
  stored `unindexedPrefixes` (both roles; virtual paths) so a later save cannot silently
  drop earlier acknowledgements, and the administrator branch returns `overrides` (the
  stored list on its own) next to the effective `mappings`, so the editor never has to
  guess which rows are template-derived.
- Override record is now `version: 2` with `unindexedPrefixes`; version 1 rows read as
  having none. `reset` now persists an empty record: the previous `null` value violated
  `app.settings.value NOT NULL` against real Postgres (a 500 on "Remove" in the browser
  test), which the in-memory repo never caught. Covered in `scopes-sftp.test.ts` step 7.
- `usableScopesFor` deleted. `validateScopeOverrides` gained `unknown_root` (index roots
  plus the template root are known); the route reports the reason in `details.reason`.
- Dev seed: carol's override is not stored by `generate-seed.ts` (the seed is SFTPGo JSON
  and files only; overrides live in the API database), so carol stays the visible unmapped
  case and the mapping is `sftpgo` + `/_folders/shared`, documented in deploy/REFERENCE.md.
- Passed: `application` (lint, typecheck, coverage), `workflow`, full `integration`
  (including `scopes-sftp.test.ts` with the two-identity virtual folder and reset steps), and
  browser `e2e/account-scope.spec.ts` 3/3 (serial: both tests edit one login's override).
- Live dev (API 3001 `tsx watch`, own Next dev server on 3004, real indexer container):
  carol non-admin view shows `/shared is not indexed. Ask an administrator`; as `dev`
  (admin) linked carol, mapped `/shared` → `sftpgo:/_folders/shared`, status turned
  Available with `/`, `/shared`; with text search temporarily enabled, carol's
  `/api/v1/search?q=team` returned `/shared/team.txt`. Restored afterwards: override reset,
  carol unlinked, text search off again (dev `features.configuration` row now exists with
  everything off, equivalent to the default). The 3002 Next server on this machine belongs to
  an old screenshots checkout under `/private/tmp` and was left alone.
- Pre-existing, unrelated: clicking "Link login" under `next dev` raised the dev overlay
  `isSearchShortcut: event.key undefined` (`apps/web/src/lib/search/shortcut.tsx`); not
  reproduced in the production-build e2e run. Not changed here.
- Follow-up (same day): folder-level mappings and suggestions, spec
  [P8-FOLDER-MAPPINGS.md](P8-FOLDER-MAPPINGS.md). `mount_mappings` settings record; adoption
  decided per login from verification evidence (two-pass verify, cached); `configuredMappings`
  now includes adopted scopes so Office and events see them. New `IndexQueries.directoriesWithFiles`
  (real-Postgres test passed, 2 cases). Routes: `GET/PUT /system/mount-mappings`,
  `GET .../scope/suggestions`. Web: suggestion chips, "Apply to every login" default, Shared
  folders card on System > Connection (now System > Shared folders, see P9).
- A parallel public-URL effort worked in this same checkout and committed to `main`
  (`08a9dbd`) while this task was in progress; none of this task's hunks were included.
  Interim gates ran in `.worktrees/scope-e2e` (branch `claude/scope-e2e`, this task's files on
  HEAD `10d8a52`): browser `account-scope.spec.ts` 3/3 and `workflow` passed there. Final gates
  ran in the main checkout on top of `08a9dbd`: `application` (lint, typecheck, coverage),
  `workflow`, browser `account-scope.spec.ts` 3/3, `scopes-sftp.test.ts` (steps 1-8), and the
  DB `directoriesWithFiles` cases (2). Live dev: suggestion `sftpgo:/_folders/shared` offered
  for carol from real index rows, saved as a shared folder mapping, carol's search returned
  `/shared/team.txt` with nothing stored on her login; card visible under System > Connection (now System > Shared folders, see P9).
  The interim worktree was removed after the main-checkout gates passed. Unrelated committed lint finding from `biome check .`:
  `apps/web/src/lib/search/queries.test.ts:314` unused `SEARCH_STARTUP_RETRY_MS`.
- Not committed. Worktree: main checkout, branch `main`.

## Auth pentest triage fixes (in progress, uncommitted)

- Source: [SHANNON-PENTEST-FINDINGS.md](SHANNON-PENTEST-FINDINGS.md), fixes table at the end.
  AUTH-VULN-01 deliberately left as a dev-environment artifact; AUTH-VULN-03 out of scope.
- Fixed 02, 04, 05, 06, 07 with regression tests. Contract change: `LinkIdentityRequest`
  now requires `currentPassword` (optional `currentOtp`); web dialog and e2e updated.
  DB behavior change: login with a replaced password revokes the account's other sessions;
  unlink revokes sessions using that login (requesting session re-pointed and rotated).
  Public share metadata is withheld for password-protected shares until the password verifies.
- Passed: `application` (lint, typecheck, coverage); DB identity-links integration (30/30);
  API `shares-sftp` and `accounts-sftp` integration against real SFTPGo/PostgreSQL; browser
  `account-identities.spec.ts` and `shares.spec.ts` against the real backend. The full
  `integration` profile also failed `sftp-rename.test.ts` on a Docker image pull for the indexer
  build (environmental, unrelated). No manual dev-UI pass beyond those e2e flows.
- Follow-up (2026-09-09): AUTH-VULN-03 closed with `FDRIVE_SESSION_MAX_AGE_DAYS` (default 90;
  `resolvePrincipal` refuses older sessions, rotation keeps `createdAt`); unlink now requires the
  owner's password like link (`UnlinkIdentityRequest` DELETE body; web dialog and e2e updated).
- Committed and pushed to `main` on 2026-09-09; CI green after Linux/CI-only fixes. Residuals recorded in the findings table (write-share metadata stays withheld;
  limiter is count-after-failure; SFTPGo-side password rotation still honours the 60s cache).

## ONLYOFFICE onboarding (verified)

- Bundled pinned engine; off until enabled in onboarding/System settings. View-only
  by default; editing requires an explicit provider-bound SFTPGo username list.
- Reviewed/transferred backend and deployment worktrees; copies retained. No migrations
  or environment activation fallback. Removed obsolete production Office overlay.
- Real controller: off → discovery-ready → off; no leftover editor, PostgreSQL,
  RabbitMQ, or Redis daemons. Proxy preserves browser host:port. Generated secrets and
  proof keys persist privately. Python lint/types/coverage and Compose variants pass.
- Application lint/types/coverage, API/DB integration, and all five affected browser
  tests pass. Live dev UI verified validation, editor selection, review, and Finish.
  Added invalid-URL and runtime toggle/callback regressions after integration findings.
  Editor menus refresh automatically after startup; editing the user list preserves its
  original revision during polling. Final frontend and workflow checks pass.
- Real bundled ONLYOFFICE suite: 7/7 passed (Word/Excel/PowerPoint coediting, saved-byte
  verification, rename/copy, external changes, read-only isolation). Collabora: 4/4 passed.
  Fixed the separate-origin editor fixture CSP; production stays on the fdrive origin.
- Work is repository/local fixtures only; no owner server access. Other agents' worktrees
  excluded from lint/build contexts without changing their content. Disposable fixtures
  cleaned up.

## Trash onboarding (verified)

- Seventh optional choice after six processing features; followed by ONLYOFFICE and review. Saved through
  provider-bound admin settings with revision checks. SFTPGo recycle rules require explicit
  operator confirmation; no WebAdmin credentials, automatic rule creation, or remote access.
- Backend reviewed and transferred; copy retained in `.worktrees/onboarding-trash-backend`.
  Each request captures a consistent configuration. Account-wide and MCP search included.
- Removed deployment/dev environment activation keys. Preflight/dev-env and focused UI
  tests pass. Application lint/types/coverage pass with `VITEST_MAX_WORKERS=2`; default
  concurrency hit unrelated 5s archive-fixture timeouts. API/DB integration and affected
  browser tests pass (onboarding resume/skip, enable, restore/conflict/purge, live disable).
- Fresh local dev UI verified: claim → connection → file-user → six processing choices →
  Trash → review → files, with Trash navigation available. Invalid hidden drafts cannot
  block disabling. Final frontend lint/typecheck/coverage passed after that form fix.
  Workflow gate passed; no remote server access or compatibility migrations.

## Generic installation documentation

- Canonical runbook: deploy/README.md. Generic host/path/account examples; existing versus
  new SFTPGo, deployment inputs before startup, mount verification, one web flow, updates,
  and failure diagnosis. Advanced reference covers named volumes, networks and permissions.
- Work in this task is repository-only. Host deployment is performed by its local operator
  or agent using the runbook; there is no pending remote-operation approval request here.
- Documentation checked against shipped Compose/scripts. Workflow verification recorded
  in the task result; no deployment operations performed for this documentation change.

## Continuous onboarding (verified)

- One shell-free `/setup` flow: claim → connection → administrator → six processing features → Trash → ONLYOFFICE → review.
  File-user verification establishes a session internally; only Finish enters the file browser.
  Reload resumes saved choices; other users skip the owner walkthrough.
- Explained WebClient file-user versus WebAdmin accounts and fdrive-only administrator rights.
  Removed SFTPGo inventory API/contracts/UI. Default home mapping; automatic storage checks
  only for enabled features. Storage/mapping controls have been removed from onboarding;
  per-account corrections remain in Account settings. Directory 400/403/404 responses are
  mapping failures, not proof of an unreachable indexer; access still fails closed.
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
  copy retained. Unrelated user agent-config/WORKING edits preserved.
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
  Opus worker defaults and explicit Fable-worker approval policy now live in `.claude/agents/` and WORKING.
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
  branch `claude/search-startup-recovery`; baseline committed HEAD, no copied prerequisites.
- Add transient scope reason and bounded polling while open; preserve scope authorization.
- Reviewed scope and production diff; committed as `af0a3d9` after user requested commit/push.
- Live dev verification: stopped local `fdrive-dev-indexer-1`, observed startup message;
  restarted indexer and saw text plus visual results for unchanged `readme` query without reload.
- Workflow, target application (lint/typecheck/coverage), and integration passed.
- Target search browser suite passed 17/17, including startup message and unchanged-query
  recovery. Logs: `/tmp/fdrive-startup-{application-final,integration,browser-final}.log`.
- Complete. Worker checkout removed after exact file comparison and target gates.
  Unrelated concurrent workflow changes preserved.

## Tester report: self-recovering workers and health (2026-09-10)

- External tester reported four defects; three reproduced from code, `init-env.sh`
  overwriting `.env` did not (script refuses to overwrite; awaiting their exact command).
- Runtime and Office controllers clear exhausted startup attempts after
  `FDRIVE_RUNTIME_RETRY_AFTER_SECONDS` (default 300) instead of only on a revision change,
  so an api restart under load no longer leaves an enabled feature dead (`467fe17`).
- Indexer health/stats handlers reopen their postgres connection after `db` is recreated;
  image embedding no longer logs a second error for a thumbnail that was never written.
- `GET /api/v1/health` gains subsystem status `failed` with the controller's reason in
  `detail`; the same reason is carried into the feature detail on System > Features
  (`ab5f9fa`). Docs: `deploy/REFERENCE.md`, `deploy/README.md`, `docs/INDEXER.md`,
  `docs/OFFICE.md`.
- Gates: runtime 27, indexer 483 (coverage gate at 83.8% fails on untouched main too),
  contracts 631, api 1959, repo typecheck and lint clean. Committed directly to main.

## Product state

- Latest search/file-browser UX merged and verified; no outstanding UX work. Prior target
  application/workflow gates passed and affected browser suite passed 31/31.
- Phase 5 strict performance gate previously passed: search25k p95 195.82 ms (<300),
  zero errors; detailed evidence in archive.
- Earlier P5 worktrees were retained by the preceding task. Do not clean them without review.
- Full prior evidence, performance work, and historical handoffs: [archive](STATUS-history.md).
  Product scope and architecture remain in [PLAN.md](../../PLAN.md).
