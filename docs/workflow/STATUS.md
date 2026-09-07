# Workflow handoff

Updated: 2026-09-07. Owner: primary agent.

## Current state

- Main remains at `1fe7388`; changes are uncommitted. Existing Codex migration
  edits preserved, with P2-CLEAR-JOBS added in this session.
- P2-CLEAR-JOBS complete. Spec: `docs/workflow/P2-CLEAR-JOBS.md`. Product decisions
  and next phases: `PLAN.md`. No personal memory written.
- Three named implementers worked in separate `codex/p2-clear-{api,indexer,web}`
  worktrees under `/Users/fredrikburmester/Documents/GitHub/fdrive-web/.worktrees`.
  Parent reviewed scope, data boundaries and every production diff, transferred
  without commits, and byte-verified all tracked/untracked changes and prerequisites.
- P2 workers finished and their temporary worktrees removed after transfer verification.
- User subsequently authorized autonomous completion of remaining phases. Active
  goal: finish Phase 3 verification, Phase 4 office, Phase 5 accounts/shares/performance, then Phase 6 recovery/extensions.
  Phase 6 scheduled by the latest all-phases instruction; P6-DESIGN.md records the bounded recovery/image/rules/WebDAV scope. Configurable embeddings remain explicitly deferred.
- Phase 3 real SFTP rename verified, foundations reviewed and transferred without
  commits. Proof helpers/discovery cache and atomic database office locks integrated.
- Office registry reviewed and integrated, including 66,000-file rename/replay
  regression. Avoids per-file SQL parameters and unbounded row materialization.
- Office deployment reviewed/integrated including root helper gates and env
  placeholders. Full lint/typecheck/coverage/integration passed. Dev services
  recreated from main with preserved keys/JWT; deploy worktree can be removed.
- P4 host, contracts and UI reviewed/integrated. Root lint/typecheck/coverage and
  container integrations passed. Office save concurrency uses one transaction and
  pre-resolved SFTP credentials; oversized bodies stage privately before overwrite.
- No active workers since the 2026-09-07 morning handover (see the last section). The
  office e2e, performance and provider-binding deltas are transferred to main. Shares API and directory foundation
  reviewed/transferred; root lint/typecheck/coverage and all four container suites
  passed. Repeated DB teardown race fixed by awaiting actual socket end events. Specs match chunk names.
- Shares DB, atomic auth DB and account API reviewed/transferred. Root lint,
  typecheck, coverage and all container integrations passed after each transfer.
  Accounts real integration covers login/link races, session/token invalidation,
  metadata transfer and same-path cross-identity download authorization.
- Completed P4 host/web/transaction and identity DB worktrees removed after verified
  transfer. Completed shares/auth/accounts API cleanup dispatched after byte checks.
- SECURITY FIX: real read-only coeditor previously typed changes that Alice's save persisted.
  Earlier explicit-edit-intent design invalid. Preserve failing readonly.spec.ts.
  SFTPGo user API/webclient/WebDAV cannot report effective overwrite; r+ and upload
  probes unsafe. Preserving credential-only mode: explicit operator policy, default
  deny, bound provider UUID/username/path; no automatic permission inference. Exact
  spec P4-EDIT-ADMISSION.md implemented. Actual readonly coediting regression passes: edit403, view allowed, reader marker never persisted through Alice save.
  Admission/core/composition and deployment policy early-transferred23files. Archive cancellation cleanup repaired and transferred2files; root lint/typecheck/coverage and all four container integration suites passed.
- Real DOCX acceptance: two writers' markers persisted; actual editor rename/save
  copy verified in SFTPGo. Main pane created OfficeRenamed.docx/OfficeSavedCopy.docx
  with test text. Filename routing now decodes Next params exactly once, verified
  spaces, Unicode and literal %20. Three-file early transfer recorded separately.
- Integrated existing browser suite74/74 passed after account API. Real XLSX
  two-writer bytes/UUID passed too. Collabora ODT opens with ASCII filename; special
  filename regression traced to upstream image locale bug. Pinned upgrade26.04.3.2.1
  opens those names; Collabora real edit/save/SFTP bytes/reopen plus filenames4/4 passed.
- Queued P5-SCOPES.md and P5-PROVIDER-BINDING.md close trusted mapping and credential
  destination gaps once Office releases composition. P5-PERFORMANCE.md active in
  isolated checkout; real TEI/PG25k hybrid search and production browser10k included.
- Dev API restarted with existing .env.dev and private ignored
  .env.office.onlyoffice.dev; watcher session93732, port3001. Private dev env grants only seeded dev user on provider04bb0ded-55f9-446b-baaf-207beacef70b; production remains default deny. Web3002 hot-reloaded.
  Dev office services healthy58090/58091, callback reachability verified. Browser
  signed in as dev; created only test file Office smoke 2026-09-07.docx for acceptance.
- No personal memory written. No commits. Copied prerequisite/transferred-delta
  hashes in /tmp/fdrive-phase-baselines/*.json. Reuse named agents; total-agent limit.

## Delivered

- Background scoped index clear and global thumbnail-cache clear. Admin-only API,
  strict request validation, shared admission with rebuilds, progress and errors.
- Bounded index batches with extraction/embedding path locks. Originals, metadata,
  cache and event history survive index clearing. Cache cleanup rejects unsafe
  paths and symlinks, includes recognized orphan previews, retains failed rows.
- Thumbnail controls consolidated on Thumbnails: scoped rebuild, force, clear,
  progress. Indexer owns clear-index and reindex; settings descriptions added.
- Browser review also fixed generic busy feedback, raw `__all__` labels and the
  Reindex selector's uncontrolled-to-controlled warning. Regression tests added.
- Normal scans/on-demand generation can repopulate cleared data; UI explains this.

## Validation

- P3/P4 foundations integrated gate: lint707 files, typecheck all packages/tools,
  coverage8/8 packages; integration4/4 suites (221 tests: db165, SFTPGo46,
  testkit6, API4). Real SFTP rename propagated metadata in2.39s in isolated fixture.
- WOPI proof tests include all eight official Microsoft vectors, rotation matrix,
  strict discovery XML/action parsing and bounded cache. New protocol modules100%.
  API998 tests, 99.42% lines, 96.20% branches, 99.68% functions.
- DB170 unit tests; new pure lock module100%; two-pool lock contention/rollback
  integration passed. withFileLock holds advisory transaction through async save.
- Registry integrated gates allgreen: lint, typecheck,8/8 coverage, container
  integration229 tests (DB173, SFTPGo46, testkit6, API4).
  DB176 unit tests,100% lines/functions,97.24% branches.
- Real discovery parser verification: ONLYOFFICE472 actions, Collabora273;
  docx edit selected and both public keys validated. Real servers healthy on
  loopback58090/58091 under fdrive-office-dev, persisted proof-key volumes.
- Downloaded ONLYOFFICE9.4.0.1 and Collabora26.04.2.2.1. Pinned ONLYOFFICE ignores
  proof-key path env overrides; uses persisted DATA_DIR keys. Collabora image is
  distroless and requires native coolwsd flags, not legacy shell/extra_params.

- Root lint clean: 692 files. Typecheck: 13/13 packages plus tools.
- Coverage gates: 8/8 packages. Final web: 1058 tests, 99.93% lines,
  98.28% branches, 100% functions. Contracts 426 tests; API 911 tests.
- Container integration: 212 tests across four packages, all passed.
- Python: ruff clean; strict mypy 18 files; Docker pytest 346 passed,
  97.15% coverage; changed production modules each 100%.
- Full Playwright after final selector fixes: 74 passed (1.2 minutes).
  Never overlapped Playwright with Turbo in the same checkout.
- Live dev pane: cache clear and force rebuild each completed 6/6, zero errors,
  restored six previews (6.1 KB). Clearing `sftpgo:dev/photo copy.png` completed
  1/1, reduced indexed files 18 to 17, preserved original/Test tag/favorite/recent.
  Reindex restored 18 files. Friendly root label and warning-free selection verified.
- Dev API on 3001, web on 3002, rebuilt indexer on 58010. Thumbnails page left
  open in Codex. Existing invalid seeded PDF still appears in indexer errors.

## Next

1. Complete Phase 4 ONLYOFFICE WOPI, UI and real-editor end-to-end plus Collabora.
2. Phase 5 accounts, shares and blocking performance budgets.
3. Phase 6 recovery, similar images, index rules and WebDAV.
4. Configurable embedding provider/model remains deferred.

## Preserved Codex migration

Root instructions, implementer/test-writer roles, three-worker cap, worktree rules,
tracking, Claude role parity and orchestration script hardening remain uncommitted
for review. Previous validation: 16 orchestration regression groups; shell syntax,
TOML parsing, role parity and lint. This fresh session confirmed named roles are
available and followed the project instructions.

- Latest foundation gate: Python375 passed97.29% (directory/server100%); root
  lint808files, typecheck13packages/tools, coverage8/8, integration282tests
  (DB216/SFTP47/testkit6/API13), all green. Completed shares API and directory
  worktrees byte-verified and removed; changes remain uncommitted in main.

- Office outstanding: valid PPTX slide/master/layout/theme blank; ONLYOFFICE view
  cache ignores strong Version when LastModifiedTime present (approved conditional
  omission, real external edit regression); Collabora save focus; /view fallback
  still has stale future-copy (approved Office preview action).
- Account UI: client-mounted Activity fixes fresh navigation/hydration, global
  search shortcut above boundary. Queued writes capture immutable identity; upload
  initial-query invalidation fixed with cancel-then-refresh; reload workarounds removed. Final production browser26/26 and web1150 tests passed. Reviewed67files transferred; integrated gates running.

- Accounts67files integrated; live pane account/linked-login fields verified. Root lint840files/typecheck passed; coverage had one unchanged Office menu test5s timeout under load. Lower-concurrency rerun active. Shares web launched in separatecodex/p5-shares-web with complete copied prerequisite baseline; locked install passed.

- Accounts integrated gate passed: lint840files, typecheck13packages/tools, coverage8/8 plus Office helpers, all four container suites. Unchanged Office menu timeout passed at lower package concurrency; assertions/timeouts unchanged. Account checkout fully byte-verified and removed. Main pane Account and Link login dialog verified.

- Office external-cache regression now passed on actual ONLYOFFICE: same-size/same-mtime SFTP replacement changes rendered text; old text0/0, new1/1. Conditional LastModifiedTime omission reviewed, final transfer pending. Controlled queued PUT after rename reproduced404/lost save; approved transaction-local fresh registry/path resolution in writes, with sameUUID/new-path/no-resurrection regressions. Original editor title-reversion issue still under investigation.
- Preview Inspector favorite stat-cache bug confirmed independently; shares worker owns narrow metadata query/stat repair for early transfer. Office worker retains strict UI-toggle acceptance once repair copied.
- Performance full diagnostic produced real API/download/upload data; latest warm p9521.09ms and API/direct92.26% passed. Search timing still fails under concurrent workloads; production UI probe refinement ongoing. Parent final quiet full gate required. Runtime process cleanup/error artifact preservation strengthened after review.

- Latest Office acceptance7/7 passed on actual ONLYOFFICE; strengthened preview favorite assertion will reload after mutation to prove server persistence once fs.stat decoration repair lands. Collabora4/4 passed, including stored text and reopened document. Rename-back behavior traced to actual editor100ms focus-selection callback racing automated fill; observed selection wait fixes harness. Separate genuine queued-save404 repaired via transaction-local fresh registry path; API1228tests/84files and3real integrations passed. Final Office transfer still pending.
- Preview metadata web repair2files reviewed/transferred; root lint/typecheck/coverage passed. Live pane exposed underlying fs.stat missing metadata decoration; assigned API2file repair. OfficeRenamed.docx test favorite temporarily enabled for this verification; remove after persistent toggle works.
- Performance probe found Space intercepted by printable-key typeahead; shares worker assigned keyboard regression/repair. Perf uses normal Enter-open for independent readiness proof.

- fs.stat metadata decoration2files reviewed/transferred root and Office prerequisites. Live pane now shows persisted favorite after reload; removal also survived reload, restoring OfficeRenamed test file to not-favorited. API repair integrated gates passed: lint/typecheck, eight package coverage gates plus Office helpers, all four integration suites. Scope-engine checkout prepared from current reviewed root; locked install passed; no worker assigned until performance report/integration.

- Final production Office run6/7: only DOCX same-paragraph coauthor sequence failed with interleaved marker. Retaining exact persistence assertions; real Save/persisted-text barrier between writers and sanitized host/editor diagnostics assigned. Other six production cases passed. Performance observer serialization defect found: transformed callback referenced module-local __name in browser; raw source plus isolated execution test fixes instrumentation, actual budget probe still pending. Shares public/management review underway; initial web1179tests passed.

- Real production10k UI revealed unconstrained shell height rendered10000 rows (~10.18s). Perf worker's minimal SidebarProvider/Inset height and scrolling fix now passes5samples each: list p9563.72ms/max37rows, grid p9571.00ms/max130tiles. All10contexts exact10000 entries with normal clicks/keyboard/scroll/open. Desktop/mobile settings scroll and package gates pending. One earlier contended response9888 remains diagnosed separately; no count or timing gate relaxed.
- Shares production review complete for public credential isolation, streamed attachment/error handling, bounded previews, password generation cancellation, management actions and keyboard integration. Final40file manifest prepared, includes environment union against frozen Office fixture; final coverage and production3scenario suite pending. Office DOCX/XLSX two-writer production checks now passed with per-writer Save barrier; remaining cases running.
- Queued scope consumer split specified in P5-SCOPE-CONSUMERS.md: explicit mapping/read checks across HTTP/Office/events and MCP, truthful bounded authorized aggregates.

- Shares40files reviewed, strict delta44including4prior repairs verified, transferred uncommitted. Production browser4/4 passed; root lint872/typecheck passed. Root coverage first attempt failed because sandbox denied localhost listeners (EPERM); identical gate rerunning escalated. Live pane created password-protected Local share check, displayed public file/download after password, then revoked successfully; test link removed. Friendly Access/Password option labels assigned as2file early repair in provider-binding checkout.
- Provider-binding launched in fresh codex/p5-provider-binding with1051reviewed prerequisite hashes and locked install. Office composition/auth/harness already identical to root, so security implementation can proceed while Office harness diagnoses PPTX stale-caret failure. Office env updated to reviewed Office/accounts/shares union plus share fixture, recorded as baseline prerequisites; final Office delta must omit env.
- Perf count mismatch reproduced directly upstream: physical10000, direct10192/API10144 but10000unique, no missing names. macOS bind-mount enumeration duplicates; isolated Docker volume with one-time population approved for same real shared filesystem, SFTPGo RW/indexer RO, exactcounts retained. Root Biome artifact exclusion and tracked result .gitignore delegated. Final volume/browser/settings proof pending.

- Shares integrated gate completed: lint872/typecheck, eight coverage packages plus Office helpers passed (web135files1189tests). Earlier failures were localhost-listener EPERM from sandbox, resolved by same gate with allowed test listeners. Completed shares checkout/branch removed after byte verification of44deltas and all prerequisites.
- Share selected-option labels2files reviewed/transferred from provider worker; root lint/typecheck/eight coverage packages plus Office helpers passed (session99330). Main pane verified Read and download label, dialog cancelled. Temporary verification link679a4c82-343c-4030-97f5-b511c87e93e6 revoked and removed; original test DOCX preserved.
- Controlled production PPTX1/1 passed after Alice exits stale title edit and selects separate body placeholder following Bob's persisted save. Strict all-three-markers/sameUUID/reopen retained. Full production Office7 rerun underway; no host failure proven.

## Handover 2026-09-07 07:20-07:45 (Claude, after the overnight session stopped)

- Found four `codex/*` worktrees at `1fe7388` with uncommitted work and no running
  workers. Computed each worktree's delta against main and verified main's copy of
  every touched file against the seeding hashes in `/tmp/fdrive-phase-baselines`.
- `p5-provider-binding` (23 files): immutable provider-bound SFTPGo clients.
  `createIdentityClientResolver` resolves identity, provider and the exact current
  connection before any credential use; `TokenSource` takes `clientForIdentity` and
  revalidates before cache reads, mints and 401 retries; `createIdentityStorageFactory`
  returns an async, pinned storage provider used by session and API-token principals;
  login/link verify credentials through `clientForBaseUrl` captured before the call.
  No lazy client remains in `composition.ts`. Fixed two test-only typecheck errors
  (`storage-factory.test.ts` generic mock, `SftpgoError` arity) and import order.
  The integration test against two upstream servers from the spec was not written;
  binding is covered by unit tests with two fake servers.
- `p4-editor-e2e` (39 files): opt-in real-editor Playwright suite
  (`apps/web/office-e2e/**`, `playwright.office.config.ts`, `pnpm test:e2e:office`,
  `.github/workflows/office-e2e.yml`, `docs/OFFICE-TESTS.md`), plus the office
  repairs it exposed: valid blank PPTX (`pptx-parts.ts`), `LastModifiedTime` sent only
  to Collabora (`cache-version.test.ts`), queued writes resolving the current registry
  path inside the write scope (`write-file.ts`), and the preview `OfficePreview`
  fallback with an identity-bound "View in office" action.
- `p5-performance` (35 files): blocking harness (`tools/perf/**`, `apps/web/perf/**`,
  `.github/workflows/performance.yml`, `pnpm perf:strict`, `pnpm test:perf:coverage`),
  the shell height fix in `(shell)/layout.tsx` with a jsdom test, Biome exclusion of
  `tools/perf/results`, root manifest scripts and the `@fdrive/db` dev dependency.
- `p5-scope-engine` carried no worker changes (prepared checkout only).
- Integrated gates on main: lint 919 files; typecheck 13 packages plus tools; coverage
  8/8 packages plus office tools (11) and perf (100) suites; office e2e helper coverage
  18 tests 100%; integration 4/4 (DB 216, SFTPGo 47, testkit 6, API 14); Playwright
  79/79; real ONLYOFFICE acceptance 7/7 (1.5 min); real Collabora 4/4; fixture
  containers cleaned.
- Perf strict gate (`pnpm perf:strict`, quiet machine, results in ignored
  `tools/perf/results/2026-09-07T05-47-21-198Z.json`): list1kCold p95 29 ms, list1k
  p95 26 ms, uiList p95 67 ms (37 rows mounted), uiGrid p95 71 ms (130 tiles), API
  download 93.7% of direct (155 vs 165 MiB/s over 512 MiB), 200-file upload 0.48 s, all
  10,000 entries verified per sample. FAIL: search25k p95 513 ms against the 300 ms
  budget (p50 282 ms) with the amd64 TEI image under emulation on Apple Silicon.
  Budget left unchanged; production search optimization is unstarted follow-up work.
  The first run failed its settings layout check because the perf identity was not an
  admin; `tools/perf/stack.ts` now sets `FDRIVE_ADMIN_USERS` to the perf user (admin
  gates only System/account routes, none of the measured paths).
- Live pane (dev/dev on 3002): `/view/OfficeRenamed.docx` shows the office card with
  "View in office", which opened the real ONLYOFFICE viewer; `/system/indexer` scrolls
  inside the bounded shell with no horizontal overflow. The web dev server had hung at
  100% CPU after the dependency change and was restarted; the API is launched through
  `.claude/launch.json` with both `.env.dev` and `.env.office.onlyoffice.dev`.
- Not done: worktree removal (`.worktrees/p4-editor-e2e`, `p5-performance`,
  `p5-provider-binding`, `p5-scope-engine`) was blocked by the session's permission
  policy; every delta is byte-verified in main, so they can be removed with
  `git worktree remove --force` and `git branch -D codex/<name>`. Still no commits.
- Next (not started, per the "finish ongoing work only" instruction): P5-SCOPE-ENGINE,
  P5-SCOPE-CONSUMERS, the provider-binding two-server integration test, Phase 6.

## Trash chunk (started 2026-09-07 morning)

- Decision: trash is a provider capability, never fdrive-owned deleted data. Spec
  `docs/workflow/P6-TRASH.md`; SFTPGo pre-delete rename rule verified on the real 2.7.5
  container (file lands at `<trash>/<dir>/<name>/<ns>`, delete returns 200, dir deletes are
  per file, deletes under the trash are permanent, overwrites are not trashed).
- Running: `trash-core` implementer in `.worktrees/trash-core` (branch `codex/trash-core`)
  owning `packages/{core,contracts,testkit,sftpgo}`. Queued: `trash-api` (apps/api, config,
  dev seed, deploy docs) and `trash-web` (apps/web) after it integrates.
- Running in parallel: `scope-engine` implementer in `.worktrees/scope-engine` (branch
  `codex/scope-engine`) owning new `apps/api/src/scoping/**` and contracts `scopes.ts`
  plus narrow routes/index additions (P5-SCOPE-ENGINE.md). Expected trivial merge with
  trash-core in `packages/contracts/src/{routes,index}.ts`. `P5-SCOPE-CONSUMERS` stays
  queued until `trash-api` integrates because both edit search and composition.
- Merged: `trash-core` (836e288) and `scope-engine` (cd3a3fc). Review fixed one real bug in
  the scope resolver: the SFTP-side verification listed `scope.fsPrefix` through the
  identity's storage, which speaks virtual paths; it now lists `virtualPrefix` and the
  indexer gets `fsPrefix`. The read authorizer's target field is `path` (virtual), not
  `fsPath`. Overrides persist in the existing `SettingsRepo` under `identity_scope:<id>`.
  Still running: `trash-api` and `trash-web`. Next after both: P5-SCOPE-CONSUMERS wiring.
- Merged: `trash-web` (1d4aa95) and `trash-api` (4855f9b). Trash is complete end to end
  pending the browser check and the trash e2e run after `conflict-guard`.
- Finding from trash-api: real SFTPGo overwrites on move/copy onto an existing file and
  merges directory copies; the fake returned 409. Running: `conflict-guard` implementer
  (`.worktrees/conflict-guard`: fake fidelity, contract cases, core restore stat guard,
  fs move/copy/rename target guard, real-container test).
- Hardening review recorded in `docs/workflow/HARDENING-REVIEW.md`. Running:
  `hardening-1` implementer (`.worktrees/hardening-1`: items 1-5, 7, 8).
- Live pane (dev/dev, dev SFTPGo recreated with the seeded rule, API restarted with
  `FDRIVE_SFTPGO_TRASH_PATH=/.trash`): context menu says "Move to Trash", dialog copy
  matches, `photo copy.zip` left Files, appeared on /trash with original folder Home and
  size, Restore returned it to Files and the Trash page showed its empty state. Root gates
  after trash-api: lint 957 files, typecheck 13, coverage 8/8 (API 1395, web 1247),
  integration 4/4 (API 15 incl. trash-sftp).
- Merged: `hardening-1` (896eee1: loopback-bound SFTPGo admin and proxy ports, `.env*` out
  of build contexts, trusted-proxy-hop client IP, `X-Forwarded-Proto https` for Secure
  cookies, bounded login limiter, MCP token redaction and no-store, public `/wopi` removed)
  and `conflict-guard` (1e92300: move/copy/rename/restore refuse an occupied target; fake
  matches real SFTPGo overwrite, `cp -r` nesting and self-move semantics, 7 contract cases,
  real-container test). Both verified: gates green (API 1438, sftpgo 383/57 real, core 292,
  integration 4/4), Playwright 81/81 after scoping the trash spec's toast locator, live pane
  refused a rename onto an existing name with a toast and left both files intact.
- Manual item: flip `FDRIVE_COOKIE_SECURE=auto` to `true` in `deploy/.env.example` (the
  session's env-file rule blocks in-place edits; the new variables were appended).
- Next: `hardening-2` (HARDENING-REVIEW items 6, 9, 10 and the lower-priority list), then
  P5-SCOPE-CONSUMERS wiring, then search performance.
- 2026-09-07 10:00: user chose security over performance. Running in parallel:
  `hardening-2` (`.worktrees/hardening-2`: web CSP/headers, indexer non-root, image pins,
  container hardening, env file modes, CI permissions/timeouts, JSON/upload caps, /about
  redaction, no-redirect SFTPGo client) and `scope-consumers` HTTP/Office/events chunk
  (`.worktrees/scope-consumers`: resolver in composition, scope routes, search on verified
  scopes with live-read filtering, thumbnails, office actor mappings, indexer listener).
  Queued after it: the MCP consumers chunk. Primary-owned follow-ups: setup-token log line
  in composition.ts, `.env.example` lines from the hardening-2 report. Search performance
  is on hold.
- Merged: `scope-consumers` (0743387). Root gates green (API 1474, integration 18 incl.
  scopes-sftp). Playwright first failed 8 search specs because the e2e fake indexer had no
  `/directory` endpoint, so verification denied index features; the fixture now lists the
  real SFTPGo container's data directory through `docker exec` (attached from
  `global-setup.ts`'s `prepareSftpgo`), search specs 8/8. Running: `hardening-2`,
  `scope-mcp` (MCP consumers chunk). Repo pushed to github.com/fredrikburmester/fdrive-web.
- Merged: `hardening-2` (c60016d). Gates: lint clean after replacing a control-character
  regex in the e2e fake indexer, typecheck 13, coverage 8/8 (API 1500, web 1261), Playwright
  81/81 on the production build with CSP. The first integration run failed at db teardown
  under turbo parallelism (216 passed, exit 1) and interrupted the api suite; both pass on
  rerun (db 216, api 18). Primary follow-ups done: office overlays pass
  `FDRIVE_OFFICE_PUBLIC_URL` as a web build arg for the CSP frame-src, api Dockerfile Node
  image digest-pinned, `.env.example` limit lines appended. Still pending in
  `composition.ts` after `scope-mcp` merges: `jsonMaxBytes` wiring and the setup-token log.
- 2026-09-07 12:00: user UX feedback recorded in `docs/workflow/P7-UX-1.md`. Running:
  `ux-shell` (`.worktrees/ux-shell`: mobile toolbar overflow, mobile search button,
  sidebar order Files/Shares/Trash, always-visible Tags/Favorites/Recents sections) and
  `ux-shares` (`.worktrees/ux-shares`: share `presentation` model with gallery/list/
  download public views, lightbox, ZIP, friendly share dialog and page copy). `scope-mcp`
  still running. Three worker slots in use.
- Merged: `scope-mcp` (b368dad). Every MCP index tool uses the token identity's verified
  scopes, round trip plus live read per candidate, 2000-candidate cap with `partial`, and
  an authorized-id chunk-stats query. Primary follow-ups done in `composition.ts`:
  `jsonMaxBytes` wired into fs routes, setup token logged at warn with a rotate-logs note.
  `apps/api` integration files now run sequentially (`fileParallelism: false`) after the
  rotating container-stopped flakes under parallel Docker load.
- Merged: `ux-shell` (117e671) and `ux-shares` (d3400a8). Primary follow-ups: Shares and
  Trash moved below the metadata sections (user intent), no-ellipsis rule applied across
  action labels (PLAN.md decision 14), inspector Tags/Favorite inset aligned, dev-only
  `unsafe-eval` in the CSP, galleries never rendered for download-limited links (each tile
  is a counted download). Gates green: lint 982 files, typecheck 13, coverage 8/8 (web
  1302), integration 4/4, Playwright 88/88 across full and per-spec runs after two label
  fixes in specs. A leftover `apps/web-e2e-shadow-*` workspace broke `pnpm install` once;
  removed. Repo pushed. Idle: no worktrees, no workers.
- 2026-09-07 afternoon: merged `search-mobile` (dbc6fb9), `archive-peek` (53bf3eb, plus
  the primary's fs-event invalidation of archive listings in 78b1b01 and a 32 MiB central
  directory bound), the activity panel collapsed by default on mobile (a8310c4), and
  `search-fixes` (fbe7744): the API returns no Folders section while a type filter is
  active (also for MCP), and result rows truncate name, path and a two-line snippet.
  Gates after the search-fixes merge: lint 1001 files, typecheck 13, coverage 8/8 (API
  1622, web 1345). Spec for the running `config-loudness` worker:
  `docs/workflow/P7-CONFIG-LOUDNESS.md` (`.worktrees/config-loudness`). One worker slot
  in use.
- Merged: `config-loudness` (6348d7b). `apps/api/src/config-keys.ts` documents every
  env key (round-trip test against `config.ts`), the API logs one startup line per
  subsystem, `/api/v1/health` carries `subsystems` (configured / not_configured /
  unreachable, missing variable names), System pages name the variable to set,
  `deploy/.env.example` and the compose `api.environment` block are generated by
  `pnpm env:example` with diff tests under `tools/deploy`, `deploy/preflight.sh` runs
  from `update.sh` (change-me, unknown FDRIVE_* keys, home template shape), `update.sh`
  resolves symlinks, `OCR_INCLUDE_GLOBS` added to `services/ocr`. Primary follow-up
  (f113c35): the public health endpoint's sidecar fan-out is cached 15 s with single
  flight (`apps/api/src/system/cached-probe.ts`); README explains that an install
  without the `index` profile reports index/search/thumbnails/OCR as unreachable. Not
  done from the spec: "Unreachable at <host>" (would expose sidecar addresses through the
  system contracts; left as a possible follow-up). Gates: lint 1012 files, typecheck 13,
  coverage 8/8, integration 4/4, Playwright 94/94. Idle: no worktrees, no workers.
- 2026-09-07 evening: second UX pass recorded in `docs/workflow/P7-UX-2.md` (shared gallery
  thumbnails, full-page lightbox, share copy, ZIP icon button, lightbox preloading; drag-to-
  select removed from the file list and grid) plus `docs/workflow/P7-IMAGE-SEARCH.md`, the
  written investigation of CLIP/SigLIP image search over the existing thumbnails. Running:
  `share-thumbs` (`.worktrees/share-thumbs`: public `GET /public/shares/:id/thumb` served from
  the index cache, never counted as a download, password verified through a cached share
  listing) and `files-selection` (`.worktrees/files-selection`: marquee deleted, background
  click-to-clear kept as a pure predicate). Queued: `share-gallery-ui` and `share-peek-api`
  after `share-thumbs`, then `share-peek-web`. Shift-click on rows is explicitly not a bug
  (user confirmed); the checkbox keeps its per-row toggle semantics.
- Merged: `files-selection` (998fcd4). Drag-to-select is gone from the list and grid;
  `lib/files/marquee.ts` and `use-marquee-selection.ts` deleted, background click-to-clear
  reimplemented as `lib/files/background-click.ts` behind a native container listener (a JSX
  `onClick` would fire for Base UI's portalled context-menu items). Primary follow-up
  (24b563b): the now-unused `onChangeSelection` prop removed from `FileList`/`FileGrid`,
  `file-browser.tsx` and `virtual-listing.tsx`. Gates: lint 1012 files, web typecheck, web
  coverage 1329 tests (functions 99.44, lines 99.95, branches 98.19). Verified in the pane:
  drag selects nothing in list and grid, no marquee rect, a click on a row's own padding now
  selects that row and a following shift-click extends the range from it (the old code cleared
  the anchor there). Playwright `apps/web/e2e/drag-select.spec.ts` written but not yet run.
  New scoping doc `docs/workflow/P7-FOLDER-VIEW.md` (per-folder view setting) and the
  `share-peek-api` / `share-peek-web` chunks appended to `P7-UX-2.md` after the user asked for
  zip peek on shared links.
- Merged: `share-thumbs` (c7512df). `GET /api/v1/public/shares/:id/thumb?path=&size=` serves the
  indexer's cached WebP through a tail (`apps/api/src/thumbs/serve.ts`) now shared with the authed
  thumb route; `shareThumbUrl` added to the contract client. Every failure is the same bare 404.
  Password-protected shares are verified with one share-root listing per (share, password), cached
  60 s in a bounded map (`shares/password-cache.ts`). Primary follow-ups before merge: the
  `toFsPath` call is wrapped so a path segment over 255 bytes is a 404 instead of an unhandled
  throw (a test proves it: it fails without the guard), and the cache key is now a salted SHA-256
  instead of the plaintext password. Verified against the real dev stack, not just the fakes:
  SFTPGo v2.7.5 answers a wrong or missing share password with 401 on `/dirs` *before* it rejects a
  single-file share with 400, so treating that 400 as "password accepted" is sound; a share listing
  consumes no download token; twelve thumbnail requests left `used_tokens` unchanged while twelve
  gallery tiles had previously consumed twelve; no cookie and a wrong password both give 404, the
  right password gives 200 image/webp; traversal, a file outside the share, and a bad size are all
  404. Gates: lint 1015 files, typecheck 13, api coverage 1678 tests (functions 99.61, lines 99.48).
  Dev-environment fix along the way: the running indexer image predated `/directory`, so scope
  verification failed and *all* index features (search, thumbnails) were silently unavailable;
  rebuilt it. Running: `image-embed-service`, `image-embed-db`.
- Merged: `image-embed-service` (b4ce6f7). New `services/image-embed` sidecar (Starlette, sibling
  of `services/ocr`): `GET /health` reporting `loading`/`ok` with the model's real dimension,
  `POST /embed/image` (multipart) and `POST /embed/text`, every vector L2-normalized by the
  service, bounds at 32 images / 64 texts / 8 MiB per image / 512 chars per text. torch,
  transformers and pillow sit in a `runtime` extra so the test venv never downloads a model and
  never imports torch; the Dockerfile installs CPU-only wheels. Gates: ruff clean, mypy strict on
  11 files, pytest 62 tests at 100% coverage. `deploy/compose.dev.yaml` gains the service under the
  `index` profile on 58012 with a `/models` weight-cache volume, and pre-wires `IMAGE_EMBED_URL`
  into the indexer. The whole `siglip.py` backend is `# pragma: no cover` by design, so a real
  image build and model load is the primary's verification and is running.
- Verified the image-embed sidecar against real weights (the whole SigLIP backend is
  `# pragma: no cover`, so this is the only proof it works). `/health` reports
  `dim: 1024`, confirming the migration's hard-coded `vector(1024)`. The first live request
  500ed: transformers 5.16 returns `BaseModelOutputWithPooling` from `get_image_features` /
  `get_text_features`, not a tensor, so `.to("cpu")` blew up — no fake could have caught this.
  Fixed in f987c33 by moving the version-dependent unwrapping into a pure, tested
  `features.py` (`pooled_features`) instead of leaving it inside the uncovered backend; 66
  tests, still 100%. After the fix: image and text vectors are both 1024-d with norm exactly
  1.0, and each colour query picks its own colour (blue 0.143 vs 0.075/0.087, red 0.142, green
  0.153). Note how low the absolute scores are even for a correct match — confirmation that
  ranking must be top-k with a relative margin, never an absolute cosine threshold, as the
  build spec already requires. Also fixed the root `biome.json` (7575cbe): `**/.worktrees`
  matched a worktree's own path segment, so `pnpm lint` inside any worker checkout reported
  every path ignored; the pattern is now anchored, and `**/.venv` is ignored so a Python
  service's local venv never reaches the formatter.
- Merged: `share-gallery-ui` (31b5264) and `image-embed-db` (0e82be9). Gallery tiles now request
  `/thumb?size=256`; the lightbox is a full-page overlay reusing `ImageViewer` and the
  `preview-shell` top-bar shape; the limit sentence, the "0 downloads · No limit" line and the big
  blue ZIP button are gone (`publicShareUsage` returns null without a limit, ZIP is a ghost icon
  button). Primary follow-up (f8fef94), from reading the preload against the real stack: every
  public share response was `no-store`, so preloading a neighbour's full-size image could never be
  reused and only spent another download. Share thumbnails now answer `private, max-age=60` (they
  are derived, content-addressed and uncounted; full downloads stay `no-store`, with a regression
  test), the preload fetches the 1024px thumbnail instead, and the lightbox shows that immediately
  and swaps to the full image once it decodes. Verified in the pane: 12 tiles cost 0 downloads
  (the same gallery cost 12 before), only images actually opened count, arrows preload the
  neighbours' 1024 thumbs. Playwright `shares.spec.ts` 5/5 against the real stack.
  `image-embed-db` adds `app.image_embeddings (content_key, model, vector(1024))` with an HNSW
  cosine index, `searchImages`/`imageEmbeddingStats` in `index-queries.ts`, the indexer's
  per-file embedding pass with a dimension/status guard, and rebuild/clear jobs. Primary
  follow-up: the `apps/api` `IndexQueries` fakes needed the two new methods (out of that chunk's
  scope, so its own gates passed while the repo did not typecheck). Gates: lint 1018, typecheck 13,
  coverage 8/8 (api 1679, web 1341, db 194), db integration 230.
- Image search verified end to end on the dev stack: rebuild embedded 10 candidates in ~12 s
  (1 error, a thumbnail row whose file I had deleted by hand — logged and skipped, which is the
  intended behaviour), 9 rows at `vector_dims = 1024` under `google/siglip2-large-patch16-256`.
  Nearest-neighbour queries through the sidecar's text tower: "a blue ocean" → ocean.png (0.091),
  "a green forest" → forest.png (0.068), "a warm orange sunset" → sunset.png (0.110), and in
  Swedish "en rosa cirkel" → rose.png (0.149). The multilingual model choice pays off. Still
  queued: `image-search-api`, `image-search-web`, `share-peek-api`, `share-peek-web`.
- 2026-09-07 later: main pushed to origin (22 commits, now `048024c`). Running in parallel:
  `image-search-api` (`.worktrees/image-search-api`, spec `docs/workflow/P7-IMAGE-SEARCH-API.md`:
  separate `GET /search/images`, sidecar text-embed client, `imageSearch` subsystem, System
  image-search get/rebuild/clear routes, compose passthrough) and `share-peek-api`
  (`.worktrees/share-peek-api`, spec in `P7-UX-2.md`). Expected trivial union merge in
  `packages/contracts/src/{routes,client}.ts`. Queued after: `image-search-web`, `share-peek-web`.
- Merged: `share-peek-api` (eb554e3). `GET /public/shares/:id/archive-entries` through a
  storage-shaped adapter (`shares/peek-adapter.ts`, suffix-range size probe with pure Content-Range
  parsing); `peekArchive` narrowed to `PeekStoragePort`. Gates: lint 1021, typecheck, contracts 555,
  api 1700. Verified on the dev stack via temporary shares (deleted afterwards): single-file and
  directory zip shares list entries, a limited link answers 403, a non-archive path 400; one peek
  costs three counted downloads on an unlimited link, as the spec accepts. Running: `image-search-api`,
  `share-peek-web` (`.worktrees/share-peek-web`).
- Lesson: the `image-search-api` worktree was created before the spec was committed, so the
  worker never saw `P7-IMAGE-SEARCH-API.md` and built an `images` section inside every text
  search response with an absolute margin. Rejected (a SigLIP text-tower call per text query, and
  required contract fields broke the web typecheck); spec copied into the worktree and a rework
  pass launched: separate `GET /search/images`, ratio margin, `system/image-search` routes,
  `SearchResponse` unchanged. Always commit or copy a spec before `git worktree add`.
- Merged: `share-peek-web` (e1eae17). Presentational archive table extracted to
  `components/preview/archive-entries-view.tsx` and shared by the authed preview and the new
  `PublicArchivePeek`; `lib/shares/peek.ts` holds the pure visibility rule (zip/tar/tar.gz/tar.zst,
  hidden on a limited link); Playwright shares spec peeks a hand-built zip fixture (6/6 in the
  worker checkout). Gates on main: lint, web typecheck, web coverage 1367 tests. Pane: a temporary
  directory share showed Peek only on the two zip rows, opening budget.zip listed budget.csv with
  no entry links; share deleted afterwards. Still running: `image-search-api` rework.
- 2026-09-07 afternoon, user feedback recorded in `docs/workflow/P7-UX-3.md`: the activity panel
  list never scrolls on desktop (ScrollArea root max-h does not bound the Base UI viewport), the
  logged-in grid never requests thumbnails, and folder size is possible from the index only.
  Running: `grid-thumbs` (`.worktrees/grid-thumbs`), `folder-size` (`.worktrees/folder-size`),
  `image-search-api` rework. Three worker slots in use; `image-search-web` queued.
- Merged: `grid-thumbs` (c3356b4). Grid tiles request the 256px thumb for image files
  (`lib/files/thumbnail.ts` reuses `previewKindFor`), icon fallback on error; the activity panel
  list is a plain `max-h-72 overflow-y-auto` region inside a `max-h-[70vh]` flex card, so the
  header, progress and collapse control stay put while the list scrolls (Base UI ScrollArea root
  max-h never bounded its viewport). Primary follow-up (1df9749): the 32px icon slot was too small
  to read as a picture, so the slot is a 56px square (icons stay 32px centred) and
  `GRID_TILE_HEIGHT` is 128. Gates: lint 1030, web typecheck, web 1376 tests; Playwright
  `grid-thumbs.spec.ts` 2/2 in the worker checkout. Pane: /files/photos shows six real thumbnails,
  the mixed root aligns icons and pictures. Running: `folder-size`, `image-search-api` rework.
